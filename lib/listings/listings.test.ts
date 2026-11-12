import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { stubGatewayEnv, TEST_GATEWAY_CONFIG } from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { endpoints, listings, orgs } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import type { LookupFn } from "../gateway/ssrf";
import { AiBusy } from "../llm";
import { createListingSchema, handleCreateListing, slugify, type ListingCaller } from "./index";

const APP = "https://piko.test";
const DIMENSIONS = 768;

describe("slugify", () => {
  it("makes a URL-safe slug from a name", () => {
    expect(slugify("Price History!")).toBe("price-history");
    expect(slugify("  Café   Reviews ")).toBe("cafe-reviews");
    expect(slugify("!!!")).toBe("listing");
  });
});

describe("createListingSchema", () => {
  const base = {
    baseUrl: "https://api.seller.example",
    name: "Weather",
    description: "Forecasts",
  };
  const issues = (input: unknown) => {
    const result = createListingSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it("reads a dollar price or a micro-USD price", () => {
    const parsed = createListingSchema.parse({
      ...base,
      endpoints: [
        { method: "get", path: "/a", price: "$0.002" },
        { method: "POST", path: "/b", priceMicro: "5000", freeQuota: 3 },
      ],
    });
    expect(parsed.endpoints).toEqual([
      { method: "GET", path: "/a", priceMicro: 2000n, freeQuota: 0 },
      { method: "POST", path: "/b", priceMicro: 5000n, freeQuota: 3 },
    ]);
    expect(parsed.kind).toBe("http");
  });

  it.each([
    [{ ...base, endpoints: [] }, /at least 1|too small|>=1/i],
    [{ ...base, endpoints: [{ method: "GET", path: "/a" }] }, /exactly one/],
    [
      { ...base, endpoints: [{ method: "GET", path: "/a", price: "1", priceMicro: "1" }] },
      /exactly one/,
    ],
    [{ ...base, endpoints: [{ method: "GET", path: "/a", price: "abc" }] }, /not a dollar amount/],
    [{ ...base, endpoints: [{ method: "GET", path: "/a", price: "-1" }] }, /between \$0 and \$100/],
    [
      { ...base, endpoints: [{ method: "GET", path: "/a", price: "101" }] },
      /between \$0 and \$100/,
    ],
    [{ ...base, endpoints: [{ method: "GET", path: "/a", priceMicro: "1.5" }] }, /whole micro-USD/],
    [{ ...base, endpoints: [{ method: "TRACE", path: "/a", price: "1" }] }, /./],
    [{ ...base, endpoints: [{ method: "GET", path: "a", price: "1" }] }, /path must start/],
    [{ ...base, endpoints: [{ method: "GET", path: "/a?x=1", price: "1" }] }, /path must start/],
    [{ ...base, endpoints: [{ method: "GET", path: "/a/../b", price: "1" }] }, /\. or \.\./],
    [
      {
        ...base,
        endpoints: [
          { method: "GET", path: "/a", price: "1" },
          { method: "get", path: "/a", price: "2" },
        ],
      },
      /listed twice/,
    ],
    [{ ...base, name: "", endpoints: [{ method: "GET", path: "/a", price: "1" }] }, /./],
    [{ ...base, slug: "Bad Slug", endpoints: [{ method: "GET", path: "/a", price: "1" }] }, /slug/],
  ])("rejects bad input %#", (input, message) => {
    const found = issues(input);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(" | ")).toMatch(message);
  });
});

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("POST /api/listings", () => {
  let db: Db;
  let seller: ListingCaller;
  const vector = new Array<number>(DIMENSIONS).fill(0).map((_, i) => (i === 0 ? 1 : 0));
  const publicDns: LookupFn = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

  function llm(embed: (text: string) => Promise<number[]> = async () => vector) {
    return {
      embed: vi.fn(embed),
      embedMany: vi.fn(async (texts: string[]) => texts.map(() => vector)),
    };
  }

  async function makeOrg(billing: "prepaid" | "invoiced", kind: "company" | "personal") {
    const slug = `org-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: "Test Org", slug, kind, billing })
      .returning({ id: orgs.id });
    return { id: org!.id, slug };
  }

  function post(
    body: unknown,
    options: {
      caller?: ListingCaller | null;
      embed?: (text: string) => Promise<number[]>;
      lookup?: LookupFn;
    } = {},
  ) {
    const model = llm(options.embed);
    const response = handleCreateListing(
      { db, llm: model, appBaseUrl: APP, lookup: options.lookup ?? publicDns },
      options.caller === undefined ? seller : options.caller,
      new Request(`${APP}/api/listings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { response, model };
  }

  const listing = (overrides: Record<string, unknown> = {}) => ({
    baseUrl: "https://api.seller.example/v1/",
    name: "Weather Now",
    description: "Current weather for a city.",
    category: "weather",
    endpoints: [
      { method: "GET", path: "/forecast", price: "0.002" },
      { method: "POST", path: "/bulk", priceMicro: "10000", freeQuota: 5 },
    ],
    ...overrides,
  });

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
    const org = await makeOrg("prepaid", "company");
    seller = { org, area: "seller", role: "admin" };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  it("creates a Listing whose gateway URL answers 402 with a Challenge", async () => {
    const { response, model } = post(listing());
    const res = await response;
    expect(res.status).toBe(201);
    const { listing: created } = await res.json();
    expect(created).toMatchObject({
      slug: "weather-now",
      name: "Weather Now",
      kind: "http",
      category: "weather",
      baseUrl: "https://api.seller.example/v1",
      seller: { slug: seller.org.slug },
      embedded: true,
    });
    expect(created.endpoints).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/forecast",
        priceMicro: "2000",
        price: "$0.002",
        freeQuota: 0,
        gatewayUrl: `${APP}/g/${seller.org.slug}/forecast`,
      }),
      expect.objectContaining({
        method: "POST",
        path: "/bulk",
        priceMicro: "10000",
        price: "$0.01",
        freeQuota: 5,
        gatewayUrl: `${APP}/g/${seller.org.slug}/bulk`,
      }),
    ]);
    expect(model.embed).toHaveBeenCalledOnce();
    expect(model.embed.mock.calls[0]![0]).toContain("Weather Now");

    // The stored rows: embedding saved, the trigger filled endpoints.seller_org_id.
    const [row] = await db.select().from(listings).where(eq(listings.id, created.id));
    expect(row!.embedding).toEqual(vector);
    const rows = await db.select().from(endpoints).where(eq(endpoints.listingId, created.id));
    expect(rows.map((r) => r.sellerOrgId)).toEqual([seller.org.id, seller.org.id]);

    const gateway = await handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      new Request(`${APP}/g/${seller.org.slug}/forecast`),
      { seller: seller.org.slug, path: ["forecast"] },
    );
    expect(gateway.status).toBe(402);
    expect(gateway.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const challenge = await gateway.json();
    expect(challenge.accepts[0]).toMatchObject({ amount: "2000", payTo: seller.org.slug });
    expect(challenge.resource.serviceName).toBe("Weather Now");
  });

  it("allows the app's own /api/demo URLs", async () => {
    const lookup: LookupFn = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    const res = await post(
      listing({
        baseUrl: `${APP}/api/demo/sellers/price-history`,
        name: "Demo History",
        endpoints: [{ method: "GET", path: "/demo-history", price: "0.001" }],
      }),
      { lookup },
    ).response;
    expect(res.status).toBe(201);
    expect((await res.json()).listing.baseUrl).toBe(`${APP}/api/demo/sellers/price-history`);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://10.0.0.5/api",
    "http://127.0.0.1:3000",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]:8080",
  ])("refuses the private address %s and writes nothing", async (baseUrl) => {
    const before = await db.select().from(listings).where(eq(listings.sellerOrgId, seller.org.id));
    const res = await post(
      listing({ baseUrl, endpoints: [{ method: "GET", path: "/ssrf", price: "1" }] }),
    ).response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({
      code: "blocked_base_url",
      reason: "blocked_address",
    });
    const after = await db.select().from(listings).where(eq(listings.sellerOrgId, seller.org.id));
    expect(after).toHaveLength(before.length);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const lookup: LookupFn = vi.fn(async () => [{ address: "192.168.1.20", family: 4 }]);
    const res = await post(
      listing({
        baseUrl: "https://intranet.seller.example",
        endpoints: [{ method: "GET", path: "/intranet", price: "1" }],
      }),
      { lookup },
    ).response;
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("blocked_base_url");
    expect(lookup).toHaveBeenCalledWith("intranet.seller.example");
  });

  it("refuses a non-http scheme and a URL with a query", async () => {
    for (const baseUrl of ["ftp://files.seller.example", "https://api.seller.example/?k=1"]) {
      const res = await post(listing({ baseUrl })).response;
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_base_url");
    }
  });

  it("refuses callers who are not a seller admin", async () => {
    const body = listing({ endpoints: [{ method: "GET", path: "/nobody", price: "1" }] });
    const signedOut = await post(body, { caller: null }).response;
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).error.code).toBe("unauthenticated");

    const wallet = await makeOrg("prepaid", "personal");
    const buyer = await post(body, { caller: { org: wallet, area: "wallet", role: "admin" } })
      .response;
    expect(buyer.status).toBe(403);
    expect((await buyer.json()).error.code).toBe("forbidden");

    const member = await post(body, { caller: { ...seller, role: "member" } }).response;
    expect(member.status).toBe(403);
  });

  it("rejects a route the seller already lists, with a clear error", async () => {
    const first = await post(
      listing({ name: "Dup One", endpoints: [{ method: "GET", path: "/dup", price: "1" }] }),
    ).response;
    expect(first.status).toBe(201);

    const second = await post(
      listing({
        name: "Dup Two",
        endpoints: [
          { method: "GET", path: "/fresh", price: "1" },
          { method: "GET", path: "/dup", price: "2" },
        ],
      }),
    ).response;
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatchObject({
      code: "route_taken",
      method: "GET",
      path: "/dup",
    });
    // Nothing from the refused Listing was written, not even its new route.
    const fresh = await db.select().from(endpoints).where(eq(endpoints.pathOrTool, "/fresh"));
    expect(fresh.filter((e) => e.sellerOrgId === seller.org.id)).toHaveLength(0);

    // Another seller may list the same route.
    const other = await makeOrg("prepaid", "company");
    const third = await post(
      listing({ name: "Dup One", endpoints: [{ method: "GET", path: "/dup", price: "1" }] }),
      { caller: { org: other, area: "seller", role: "admin" } },
    ).response;
    expect(third.status).toBe(201);
  });

  it("gives a second Listing with the same name a new slug, and refuses a taken slug", async () => {
    const a = await post(
      listing({ name: "Same Name", endpoints: [{ method: "GET", path: "/same-a", price: "1" }] }),
    ).response;
    const b = await post(
      listing({ name: "Same Name", endpoints: [{ method: "GET", path: "/same-b", price: "1" }] }),
    ).response;
    expect((await a.json()).listing.slug).toBe("same-name");
    expect((await b.json()).listing.slug).toBe("same-name-2");

    const c = await post(
      listing({
        name: "Other",
        slug: "same-name",
        endpoints: [{ method: "GET", path: "/same-c", price: "1" }],
      }),
    ).response;
    expect(c.status).toBe(409);
    expect((await c.json()).error.code).toBe("slug_taken");
  });

  it("still creates the Listing when the embedding model is busy", async () => {
    const res = await post(
      listing({ name: "Busy Model", endpoints: [{ method: "GET", path: "/busy", price: "1" }] }),
      {
        embed: async () => {
          throw new AiBusy([{ model: "google:test", reason: "rate_limited", status: 429 }]);
        },
      },
    ).response;
    expect(res.status).toBe(201);
    const { listing: created } = await res.json();
    expect(created.embedded).toBe(false);
    const [row] = await db.select().from(listings).where(eq(listings.id, created.id));
    expect(row!.embedding).toBeNull();
  });

  it("does not hide other embedding errors", async () => {
    await expect(
      post(
        listing({ name: "Broken", endpoints: [{ method: "GET", path: "/broken", price: "1" }] }),
        {
          embed: async () => {
            throw new Error("bad key");
          },
        },
      ).response,
    ).rejects.toThrow("bad key");
  });

  it("answers 400 for a body that is not JSON or not a Listing", async () => {
    const notJson = await post("{nope").response;
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error.code).toBe("invalid_request");

    const bad = await post({ baseUrl: "https://api.seller.example", endpoints: [] }).response;
    expect(bad.status).toBe(400);
    const { error } = await bad.json();
    expect(error.code).toBe("invalid_request");
    expect(error.issues.length).toBeGreaterThan(0);
  });
});
