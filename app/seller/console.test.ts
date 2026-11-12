import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
  type StubUpstream,
} from "@/test/gateway-fixtures";
import type { Principal } from "@/lib/auth";
import { createDb, type Db } from "@/lib/db/client";
import { challenges, endpoints } from "@/lib/db/schema";
import { handleGatewayRequest } from "@/lib/gateway";
import { sellerListings } from "@/lib/listings";
import { editEndpoint } from "./console";

const url = inject("testDatabaseUrl");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe.skipIf(!url)("Seller console: editing an Endpoint", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
    upstream = await startStubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  function principalFor(
    seller: { orgId: string; slug: string },
    overrides: Partial<Principal> = {},
  ): Principal {
    return {
      account: { id: randomUUID(), email: "priya@demo.piko", name: "Priya" },
      org: { id: seller.orgId, name: "Priya Labs", slug: seller.slug, kind: "company" },
      role: "admin",
      area: "seller",
      ...overrides,
    } as Principal;
  }

  function call(seller: { slug: string; path: string }, key?: string) {
    return handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}${seller.path}`, { key }),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
  }

  async function challenge(seller: { slug: string; path: string }) {
    const res = await call(seller);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      accepts: Array<{ amount: string; extra: { nonce: string } }>;
    };
    return body.accepts[0]!;
  }

  const endpointRow = async (id: string) =>
    (await db.select().from(endpoints).where(eq(endpoints.id, id)))[0]!;

  it("shows the new price on the next Challenge and leaves an issued one unchanged", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 2_000n });
    const before = await challenge(seller);
    expect(before.amount).toBe("2000");

    const state = await editEndpoint(
      { db },
      principalFor(seller),
      form({ endpointId: seller.endpointId, price: "0.005", freeQuota: "0" }),
    );
    expect(state).toEqual({ saved: { price: "$0.005", freeQuota: 0 } });

    const after = await challenge(seller);
    expect(after.amount).toBe("5000");

    const [old] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.nonce, before.extra.nonce));
    expect(old!.amountMicro).toBe(2_000n);
  });

  it("applies a new free allowance to the next request", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 2_000n });
    const buyer = await createBuyer(db);
    expect((await call(seller, buyer.rawKey)).status).toBe(402);

    const state = await editEndpoint(
      { db },
      principalFor(seller),
      form({ endpointId: seller.endpointId, price: "$0.002", freeQuota: "1" }),
    );
    expect(state.saved).toEqual({ price: "$0.002", freeQuota: 1 });

    expect((await call(seller, buyer.rawKey)).status).toBe(200);
    expect((await call(seller, buyer.rawKey)).status).toBe(402);
  });

  it("refuses a member, another area and a signed-out caller", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 2_000n });
    const fields = form({ endpointId: seller.endpointId, price: "9", freeQuota: "0" });
    for (const principal of [
      principalFor(seller, { role: "member" }),
      principalFor(seller, { area: "wallet" }),
      null,
    ]) {
      expect((await editEndpoint({ db }, principal, fields)).error).toMatch(/Only an admin/);
    }
    expect((await endpointRow(seller.endpointId)).priceMicro).toBe(2_000n);
  });

  it("refuses another seller org's Endpoint and an unknown id", async () => {
    const priya = await createSeller(db, upstream.url, { priceMicro: 2_000n });
    const other = await createSeller(db, upstream.url, { priceMicro: 3_000n });
    for (const endpointId of [other.endpointId, randomUUID(), "not-a-uuid"]) {
      const state = await editEndpoint(
        { db },
        principalFor(priya),
        form({ endpointId, price: "9", freeQuota: "0" }),
      );
      expect(state.error).toBe("No such Endpoint on your Listings.");
    }
    expect((await endpointRow(other.endpointId)).priceMicro).toBe(3_000n);
  });

  it.each([
    ["abc", "0", "price", /dollars/],
    ["100.01", "0", "price", /between \$0 and \$100/],
    ["-1", "0", "price", /./],
    ["", "0", "price", /./],
    ["0.002", "lots", "freeQuota", /whole number/],
    ["0.002", "2000000", "freeQuota", /whole number/],
  ])("refuses price %j with free quota %j", async (price, freeQuota, field, message) => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 2_000n });
    const state = await editEndpoint(
      { db },
      principalFor(seller),
      form({ endpointId: seller.endpointId, price, freeQuota }),
    );
    expect(state.error).toBe("Check the highlighted fields.");
    expect(state.fieldErrors?.[field as "price" | "freeQuota"]).toMatch(message);
    const row = await endpointRow(seller.endpointId);
    expect(row.priceMicro).toBe(2_000n);
    expect(row.freeQuota).toBe(0);
  });

  it("lists the org's Listings with Endpoints and gateway URLs", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 2_000n, freeQuota: 3 });
    const listed = await sellerListings(db, seller, "https://piko.test/");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Test Listing", kind: "http" });
    expect(listed[0]!.endpoints).toEqual([
      {
        id: seller.endpointId,
        method: "GET",
        path: "/history",
        priceMicro: 2_000n,
        freeQuota: 3,
        gatewayUrl: `https://piko.test/g/${seller.slug}/history`,
      },
    ]);
  });
});
