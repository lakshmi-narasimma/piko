import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { Principal } from "@/lib/auth";
import { createDb, type Db } from "@/lib/db/client";
import { listings, orgs } from "@/lib/db/schema";
import type { LookupFn } from "@/lib/gateway/ssrf";
import { AiBusy } from "@/lib/llm";
import { connectListing, listingInputFromForm } from "./connect";

const APP = "https://piko.test";
const DIMENSIONS = 768;

/** A FormData the way the form sends it: endpoints as `endpoints.{i}.{field}`. */
function formData(fields: Record<string, string>, rows: Array<Record<string, string>>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  rows.forEach((row, i) => {
    for (const [name, value] of Object.entries(row)) form.set(`endpoints.${i}.${name}`, value);
  });
  return form;
}

const FIELDS = {
  baseUrl: "https://api.seller.example/v1",
  name: "Weather Now",
  description: "Current weather for a city.",
  category: "",
  kind: "http",
};

describe("listingInputFromForm", () => {
  it("reads the rows in order and leaves blank optional fields out", () => {
    const form = formData(FIELDS, [
      { method: "GET", path: "/a", price: "0.002", freeQuota: "" },
      { method: "POST", path: " /b ", price: "1", freeQuota: "5" },
    ]);
    form.set("orgId", "someone-elses-org");
    expect(listingInputFromForm(form)).toEqual({
      baseUrl: FIELDS.baseUrl,
      name: FIELDS.name,
      description: FIELDS.description,
      kind: "http",
      endpoints: [
        { method: "GET", path: "/a", price: "0.002" },
        { method: "POST", path: "/b", price: "1", freeQuota: 5 },
      ],
    });
  });

  it("reads a non-numeric free quota as NaN so the schema refuses it", () => {
    const input = listingInputFromForm(
      formData(FIELDS, [{ method: "GET", path: "/a", price: "1", freeQuota: "lots" }]),
    );
    expect(input.endpoints[0]!.freeQuota).toBeNaN();
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("connectListing", () => {
  let db: Db;
  let priya: Principal;
  const vector = new Array<number>(DIMENSIONS).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  const publicDns: LookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  function connect(
    form: FormData,
    options: {
      principal?: Principal | null;
      embed?: () => Promise<number[]>;
      lookup?: LookupFn;
    } = {},
  ) {
    const llm = {
      embed: vi.fn(options.embed ?? (async () => vector)),
      embedMany: vi.fn(async (texts: string[]) => texts.map(() => vector)),
    };
    return connectListing(
      { db, llm, appBaseUrl: APP, lookup: options.lookup ?? publicDns },
      options.principal === undefined ? priya : options.principal,
      form,
    );
  }

  const count = async () =>
    (await db.select().from(listings).where(eq(listings.sellerOrgId, priya.org.id))).length;

  beforeAll(async () => {
    db = createDb(url!, { max: 3 });
    const slug = `seller-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: "Priya Labs", slug, kind: "company", billing: "prepaid" })
      .returning({ id: orgs.id });
    priya = {
      account: { id: randomUUID(), email: "priya@demo.piko", name: "Priya" },
      org: { id: org!.id, name: "Priya Labs", slug, kind: "company" },
      role: "admin",
      area: "seller",
    };
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("publishes the Listing and returns each endpoint's gateway URL", async () => {
    const state = await connect(
      formData(FIELDS, [
        { method: "GET", path: "/forecast", price: "0.002", freeQuota: "" },
        { method: "post", path: "/bulk", price: "$0.01", freeQuota: "5" },
      ]),
    );
    expect(state.error).toBeUndefined();
    expect(state.listing).toMatchObject({
      slug: "weather-now",
      name: "Weather Now",
      embedded: true,
      endpoints: [
        {
          method: "GET",
          path: "/forecast",
          price: "$0.002",
          freeQuota: 0,
          gatewayUrl: `${APP}/g/${priya.org.slug}/forecast`,
        },
        {
          method: "POST",
          path: "/bulk",
          price: "$0.01",
          freeQuota: 5,
          gatewayUrl: `${APP}/g/${priya.org.slug}/bulk`,
        },
      ],
    });
    // Plain data for the client: no bigint micro-USD crosses to the browser.
    expect(JSON.stringify(state)).toContain("gatewayUrl");
  });

  it("accepts the app's own demo seller URL and says when indexing is pending", async () => {
    const lookup: LookupFn = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const state = await connect(
      formData({ ...FIELDS, baseUrl: `${APP}/api/demo/sellers/price-history`, name: "Demo" }, [
        { method: "GET", path: "/demo-history", price: "0.002" },
      ]),
      {
        lookup,
        embed: async () => {
          throw new AiBusy([]);
        },
      },
    );
    expect(state.listing?.embedded).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("maps validation issues to the fields they belong to", async () => {
    const before = await count();
    const state = await connect(
      formData({ ...FIELDS, name: "", description: "x".repeat(501) }, [
        { method: "GET", path: "nope", price: "0.002" },
        { method: "GET", path: "/ok", price: "abc" },
        { method: "GET", path: "/free", price: "", freeQuota: "lots" },
        { method: "GET", path: "/blank", price: "" },
      ]),
    );
    expect(state.error).toBe("Check the highlighted fields.");
    expect(state.fieldErrors).toEqual({
      name: expect.stringMatching(/name/),
      description: expect.stringMatching(/500/),
      "endpoints.0.path": expect.stringMatching(/must start with \//),
      "endpoints.1.price": expect.stringMatching(/not a dollar amount/),
      "endpoints.2.freeQuota": expect.stringMatching(/whole number/),
      "endpoints.3.price": "Enter a price in dollars, like 0.002.",
    });
    expect(state.listing).toBeUndefined();
    expect(await count()).toBe(before);
  });

  it("puts a route listed twice on the repeated row's path", async () => {
    const state = await connect(
      formData(FIELDS, [
        { method: "GET", path: "/twice", price: "1" },
        { method: "get", path: "/twice", price: "2" },
      ]),
    );
    expect(state.fieldErrors).toEqual({
      "endpoints.1.path": expect.stringMatching(/GET \/twice is listed twice/),
    });
  });

  it("asks for at least one endpoint", async () => {
    const state = await connect(formData(FIELDS, []));
    expect(state.fieldErrors).toEqual({ endpoints: "Add 1 to 50 endpoints." });
  });

  it("explains a blocked base URL without writing anything", async () => {
    const before = await count();
    const state = await connect(
      formData({ ...FIELDS, baseUrl: "http://10.0.0.5/api" }, [
        { method: "GET", path: "/ssrf", price: "1" },
      ]),
    );
    const message =
      "That address can't be reached from Piko: private or local addresses aren't allowed.";
    expect(state).toEqual({ error: message, fieldErrors: { baseUrl: message } });
    expect(await count()).toBe(before);
  });

  it("explains a host that doesn't resolve", async () => {
    const lookup: LookupFn = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    const state = await connect(
      formData({ ...FIELDS, baseUrl: "https://nowhere.example" }, [
        { method: "GET", path: "/nowhere", price: "1" },
      ]),
      { lookup },
    );
    expect(state.fieldErrors?.baseUrl).toMatch(/doesn't resolve/);
  });

  it("puts a route clash on the row that clashes", async () => {
    const state = await connect(
      formData({ ...FIELDS, name: "Weather Again" }, [
        { method: "GET", path: "/new-route", price: "1" },
        { method: "GET", path: "/forecast", price: "1" },
      ]),
    );
    expect(state.error).toMatch(/already list GET \/forecast/);
    expect(Object.keys(state.fieldErrors ?? {})).toEqual(["endpoints.1.path"]);
  });

  it.each([
    ["signed out", null],
    ["a seller member", { role: "member" as const }],
    ["a Wallet account", { area: "wallet" as const }],
  ])("refuses %s", async (_, change) => {
    const before = await count();
    const state = await connect(
      formData({ ...FIELDS, name: "Refused" }, [{ method: "GET", path: "/refused", price: "1" }]),
      { principal: change === null ? null : { ...priya, ...change } },
    );
    expect(state).toEqual({ error: "Only an admin of a seller org can connect an API." });
    expect(await count()).toBe(before);
  });
});
