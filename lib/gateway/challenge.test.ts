import { randomUUID } from "node:crypto";
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
import { agents, calls, challenges, ledgerEntries } from "../db/schema";
import { decodeHeaderValue, type PaymentRequired } from "../x402";
import { handleGatewayRequest } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: challenge and free allowance", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
    upstream = await startStubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  function call(
    seller: { slug: string; path: string },
    init: { key?: string; method?: string; headers?: Record<string, string>; query?: string } = {},
  ) {
    const method = init.method ?? "GET";
    const target = `https://piko.test/g/${seller.slug}${seller.path}${init.query ?? ""}`;
    return handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest(method, target, init),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
  }

  const free = (endpointId: string, orgId: string) =>
    db
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.endpointId, endpointId),
          eq(calls.buyerOrgId, orgId),
          eq(calls.status, "free"),
        ),
      );

  it("returns 402 with a valid challenge and a base64 PAYMENT-REQUIRED header", async () => {
    const seller = await createSeller(db, upstream.url);

    const res = await call(seller);

    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequired;
    expect(decodeHeaderValue(res.headers.get("PAYMENT-REQUIRED")!)).toEqual(body);
    expect(body.x402Version).toBe(2);
    expect(body.resource).toEqual({
      url: `https://piko.test/g/${seller.slug}/history`,
      description: "For gateway tests",
      mimeType: "application/json",
      serviceName: "Test Listing",
    });
    const accepted = body.accepts[0]!;
    expect(accepted).toMatchObject({
      scheme: "paypal-ledger",
      network: "paypal:sandbox",
      amount: "2000",
      asset: "USD",
      payTo: seller.slug,
      maxTimeoutSeconds: 60,
    });
    expect(accepted.extra).toMatchObject({
      decimals: 6,
      facilitator: "https://piko.test/api/facilitator",
      payUrl: "https://piko.test/api/pay",
    });
    expect(body.accepts).toHaveLength(1);

    const [stored] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.nonce, accepted.extra.nonce));
    expect(stored).toMatchObject({ endpointId: seller.endpointId, amountMicro: 2_000n });
    expect(stored!.agentId).toBeNull();
    expect(stored!.buyerOrgId).toBeNull();
    expect(stored!.expiresAt.toISOString()).toBe(accepted.extra.expiresAt);
    const ttlMs = stored!.expiresAt.getTime() - stored!.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(29_000);
    expect(ttlMs).toBeLessThan(31_000);
  });

  it("binds the Challenge to the buyer when a Key is sent, and still returns 402", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db);

    const res = await call(seller, { key: buyer.rawKey });

    expect(res.status).toBe(402);
    const { accepts } = (await res.json()) as PaymentRequired;
    const [stored] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.nonce, accepts[0]!.extra.nonce));
    expect(stored).toMatchObject({ agentId: buyer.agentId, buyerOrgId: buyer.orgId });
  });

  it("returns a clear 404 for an unknown seller or route", async () => {
    const seller = await createSeller(db, upstream.url);

    const unknownSeller = await call({ slug: `nobody-${randomUUID()}`, path: "/history" });
    const unknownPath = await call({ slug: seller.slug, path: "/nope" });
    const wrongMethod = await call(seller, { method: "POST" });

    for (const res of [unknownSeller, unknownPath, wrongMethod]) {
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("does not offer a GET endpoint to a HEAD request", async () => {
    const seller = await createSeller(db, upstream.url);
    expect((await call(seller, { method: "HEAD" })).status).toBe(404);
  });

  it("answers an OPTIONS preflight without asking for payment", async () => {
    const seller = await createSeller(db, upstream.url);

    const res = await call(seller, { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("PAYMENT-SIGNATURE");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-RESPONSE");
  });

  it("exposes the payment headers on a 402", async () => {
    const seller = await createSeller(db, upstream.url);
    const res = await call(seller);
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects a wrong Key with 401", async () => {
    const seller = await createSeller(db, upstream.url);
    const res = await call(seller, { key: "pk_agent_wrong" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "invalid_key" } });
  });

  it("returns 423 agent_frozen with the scope for a frozen agent's Key", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 3 });
    const buyer = await createBuyer(db);
    await db.update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, buyer.agentId));

    const res = await call(seller, { key: buyer.rawKey });

    expect(res.status).toBe(423);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "agent_frozen", scope: "agent" },
    });
    expect(await free(seller.endpointId, buyer.orgId)).toHaveLength(0);
  });

  it("gives the first 5 Calls free, and the 6th gets a 402", async () => {
    const seller = await createSeller(db, upstream.url, {
      priceMicro: 10_000n,
      freeQuota: 5,
      path: "/search",
    });
    const buyer = await createBuyer(db);
    const before = upstream.requests.length;

    for (let i = 0; i < 5; i++) {
      const res = await call(seller, { key: buyer.rawKey, query: `?q=monitor${i}` });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(res.headers.has("PAYMENT-REQUIRED")).toBe(false);
    }

    const sixth = await call(seller, { key: buyer.rawKey });
    expect(sixth.status).toBe(402);

    expect(upstream.requests.length - before).toBe(5);
    expect(upstream.requests.at(-1)!.url).toBe("/search?q=monitor4");

    const rows = await free(seller.endpointId, buyer.orgId);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({
        amountMicro: 0n,
        status: "free",
        agentId: buyer.agentId,
        upstreamStatus: 200,
        nonce: null,
      });
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orgId, buyer.orgId));
    expect(ledger).toHaveLength(0);
  });

  it("keeps a separate free allowance per buyer", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 1 });
    const first = await createBuyer(db);
    const second = await createBuyer(db);

    expect((await call(seller, { key: first.rawKey })).status).toBe(200);
    expect((await call(seller, { key: first.rawKey })).status).toBe(402);
    expect((await call(seller, { key: second.rawKey })).status).toBe(200);
  });

  it("shows a 402 to a caller with no Key, even when the Endpoint has a free allowance", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 5 });
    expect((await call(seller)).status).toBe(402);
  });

  it("does not exceed the free allowance under concurrent requests", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 2 });
    const buyer = await createBuyer(db);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(seller, { key: buyer.rawKey })),
    );

    expect(results.filter((res) => res.status === 200)).toHaveLength(2);
    expect(results.filter((res) => res.status === 402)).toHaveLength(4);
    expect(await free(seller.endpointId, buyer.orgId)).toHaveLength(2);
  });

  it("does not use up the free allowance when the upstream fails", async () => {
    const failing = await startStubUpstream();
    failing.respond((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const seller = await createSeller(db, failing.url, { freeQuota: 1 });
    const buyer = await createBuyer(db);

    const res = await call(seller, { key: buyer.rawKey });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "upstream_failed", refunded: false },
    });
    expect(await free(seller.endpointId, buyer.orgId)).toHaveLength(0);

    failing.respond((_req, r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end("{}");
    });
    expect((await call(seller, { key: buyer.rawKey })).status).toBe(200);
    await failing.close();
  });

  it("never forwards the agent's Key or a caller-chosen X-Piko-Secret upstream", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 1 });
    const buyer = await createBuyer(db);

    await call(seller, {
      key: buyer.rawKey,
      headers: { "X-Piko-Secret": "forged", "X-Custom": "kept" },
    });

    const received = upstream.requests.at(-1)!.headers;
    expect(received.authorization).toBeUndefined();
    expect(received["x-piko-secret"]).toBeUndefined();
    expect(received["x-custom"]).toBe("kept");
  });
});
