import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { calls, challenges, ledgerEntries } from "../db/schema";
import { handleGatewayRequest } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: $0 Endpoints and the free allowance", () => {
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

  function call(seller: { slug: string; path: string }, key?: string) {
    return handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}${seller.path}`, { key }),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
  }

  const callsTo = (endpointId: string) =>
    db.select().from(calls).where(eq(calls.endpointId, endpointId));
  const challengesFor = (endpointId: string) =>
    db.select().from(challenges).where(eq(challenges.endpointId, endpointId));

  it("forwards a $0 Endpoint without a Challenge and records a free Call", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 0n });
    const buyer = await createBuyer(db);

    for (let i = 0; i < 3; i++) {
      const res = await call(seller, buyer.rawKey);
      expect(res.status).toBe(200);
      expect(res.headers.has("PAYMENT-REQUIRED")).toBe(false);
      await expect(res.json()).resolves.toEqual({ ok: true });
    }

    const rows = await callsTo(seller.endpointId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        agentId: buyer.agentId,
        buyerOrgId: buyer.orgId,
        amountMicro: 0n,
        status: "free",
        upstreamStatus: 200,
        nonce: null,
      });
    }
    expect(await challengesFor(seller.endpointId)).toHaveLength(0);
    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orgId, buyer.orgId));
    expect(ledger).toHaveLength(0);
  });

  it("forwards a $0 Endpoint for a caller with no Key, recording nothing", async () => {
    const seller = await createSeller(db, upstream.url, { priceMicro: 0n });

    const res = await call(seller);

    expect(res.status).toBe(200);
    expect(await callsTo(seller.endpointId)).toHaveLength(0);
    expect(await challengesFor(seller.endpointId)).toHaveLength(0);
  });

  it("does not record a $0 Call whose upstream fails", async () => {
    const failing = await startStubUpstream();
    failing.respond((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const seller = await createSeller(db, failing.url, { priceMicro: 0n });
    const buyer = await createBuyer(db);

    const res = await call(seller, buyer.rawKey);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "upstream_failed" } });
    expect(await callsTo(seller.endpointId)).toHaveLength(0);
    await failing.close();
  });

  it("does not count simulated free Calls against the buyer's allowance", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 2 });
    const buyer = await createBuyer(db);
    await db.insert(calls).values(
      Array.from({ length: 2 }, () => ({
        agentId: buyer.agentId,
        buyerOrgId: buyer.orgId,
        endpointId: seller.endpointId,
        amountMicro: 0n,
        status: "free" as const,
        simulated: true,
      })),
    );

    expect((await call(seller, buyer.rawKey)).status).toBe(200);
    expect((await call(seller, buyer.rawKey)).status).toBe(200);
    expect((await call(seller, buyer.rawKey)).status).toBe(402);

    const real = await db
      .select()
      .from(calls)
      .where(and(eq(calls.endpointId, seller.endpointId), eq(calls.simulated, false)));
    expect(real).toHaveLength(2);
  });
});
