import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { agents, calls, endpoints, listings, orgs } from "../db/schema";
import { callsAfter, recentCalls } from "./feed";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("call feed", () => {
  let db: Db;
  let buyer: string;
  let seller: string;
  let agentId: string;
  let endpointId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const org = async (name: string) => {
      const [row] = await db
        .insert(orgs)
        .values({ name, slug: `${name}-${randomUUID()}`, kind: "company", billing: "prepaid" })
        .returning({ id: orgs.id });
      return row!.id;
    };
    buyer = await org("feed-buyer");
    seller = await org("feed-seller");
    const [agent] = await db
      .insert(agents)
      .values({ orgId: buyer, name: "feed-agent" })
      .returning({ id: agents.id });
    agentId = agent!.id;
    const [listing] = await db
      .insert(listings)
      .values({
        sellerOrgId: seller,
        slug: `feed-${randomUUID()}`,
        name: "Feed API",
        description: "d",
        baseUrl: "http://localhost/x",
        kind: "http",
        category: "test",
      })
      .returning({ id: listings.id });
    const [endpoint] = await db
      .insert(endpoints)
      .values({ listingId: listing!.id, method: "GET", pathOrTool: "/x", priceMicro: 2_000n })
      .returning({ id: endpoints.id });
    endpointId = endpoint!.id;
  });
  afterAll(async () => {
    await db.$client.end();
  });

  const record = (amountMicro = 2_000n) =>
    db
      .insert(calls)
      .values({ agentId, buyerOrgId: buyer, endpointId, amountMicro, status: "paid" });

  it("shows an org only its own side of the traffic", async () => {
    await record();
    expect((await recentCalls(db, { orgId: buyer, side: "buyer" })).calls).toHaveLength(1);
    expect((await recentCalls(db, { orgId: seller, side: "seller" })).calls).toHaveLength(1);
    expect((await recentCalls(db, { orgId: seller, side: "buyer" })).calls).toHaveLength(0);
    expect((await recentCalls(db, { orgId: buyer, side: "seller" })).calls).toHaveLength(0);
  });

  it("returns only new Calls after the cursor, each exactly once", async () => {
    const first = await recentCalls(db, { orgId: buyer, side: "buyer" });
    expect(first.cursor).not.toBeNull();
    expect(
      (await callsAfter(db, { orgId: buyer, side: "buyer", cursor: first.cursor! })).calls,
    ).toEqual([]);

    await record(3_000n);
    await record(4_000n);
    const next = await callsAfter(db, { orgId: buyer, side: "buyer", cursor: first.cursor! });
    expect(next.calls.map((c) => c.amountMicro)).toEqual(["3000", "4000"]);
    expect(next.calls[0]).toMatchObject({ agent: "feed-agent", endpoint: "Feed API GET /x" });

    const again = await callsAfter(db, { orgId: buyer, side: "buyer", cursor: next.cursor });
    expect(again.calls).toEqual([]);
  });
});
