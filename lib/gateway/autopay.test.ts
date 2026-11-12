import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  callEntries,
  createBuyer,
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, challenges, ledgerEntries } from "../db/schema";
import { availableFunds, balanceOf } from "../ledger";
import { decodeHeaderValue, type SettlementResponse } from "../x402";
import { handleGatewayRequest } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: X-Piko-Autopay", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
    upstream = await startStubUpstream();
  });

  afterEach(() => {
    upstream.respond((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  type Seller = Awaited<ReturnType<typeof createSeller>>;

  function autopay(
    seller: Seller,
    key: string | undefined,
    value = "true",
    extraHeaders: Record<string, string> = {},
  ) {
    return handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, {
        key,
        headers: { "X-Piko-Autopay": value, ...extraHeaders },
      }),
      { seller: seller.slug, path: ["history"] },
    );
  }

  const errorOf = async (res: Response) => ((await res.json()) as { error: object }).error;

  it("returns the upstream body and charges exactly once", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const before = upstream.requests.length;

    const res = await autopay(seller, buyer.rawKey);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(upstream.requests.length - before).toBe(1);
    expect(upstream.requests.at(-1)!.headers["x-piko-autopay"]).toBeUndefined();
    expect(upstream.requests.at(-1)!.headers.authorization).toBeUndefined();

    const settlement = decodeHeaderValue(
      res.headers.get("PAYMENT-RESPONSE")!,
    ) as SettlementResponse;
    expect(settlement).toMatchObject({
      success: true,
      payer: buyer.agentId,
      amount: "2000",
      network: "paypal:sandbox",
    });

    const entries = await callEntries(db, settlement.transaction);
    expect(entries.map((entry) => entry.amountMicro)).toEqual([-2_000n, 1_900n, 100n]);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);

    const paid = await db
      .select()
      .from(calls)
      .where(and(eq(calls.buyerOrgId, buyer.orgId), eq(calls.endpointId, seller.endpointId)));
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ status: "paid", amountMicro: 2_000n, upstreamStatus: 200 });

    const [challenge] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.nonce, paid[0]!.nonce!));
    expect(challenge!.consumedAt).not.toBeNull();
    expect(challenge).toMatchObject({ agentId: buyer.agentId, buyerOrgId: buyer.orgId });
  });

  it("charges each of two sequential Calls once", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);

    expect((await autopay(seller, buyer.rawKey)).status).toBe(200);
    expect((await autopay(seller, buyer.rawKey)).status).toBe(200);

    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(6_000n);
  });

  it("does not overdraw a wallet under concurrent autopay requests", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 3_000n);
    const before = upstream.requests.length;

    const results = await Promise.all([1, 2, 3].map(() => autopay(seller, buyer.rawKey)));

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 402, 402]);
    expect(upstream.requests.length - before).toBe(1);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(1_000n);
  });

  it("returns 402 insufficient_funds without calling the upstream", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db);
    const before = upstream.requests.length;

    const res = await autopay(seller, buyer.rawKey);

    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: "insufficient_funds" });
    expect(res.headers.has("PAYMENT-REQUIRED")).toBe(false);
    expect(upstream.requests.length).toBe(before);
  });

  it("needs a Key: 401 with none and for a wrong one", async () => {
    const seller = await createSeller(db, upstream.url);
    for (const key of [undefined, "pk_agent_wrong"]) {
      const res = await autopay(seller, key);
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toMatchObject({ code: "invalid_key" });
    }
  });

  it("does not pay when the agent is frozen", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    await db.update(agents).set({ frozenAt: new Date() }).where(eq(agents.id, buyer.agentId));
    const before = upstream.requests.length;

    const res = await autopay(seller, buyer.rawKey);

    expect(res.status).toBe(423);
    expect(await errorOf(res)).toMatchObject({ code: "agent_frozen", scope: "agent" });
    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("uses the free allowance first, then pays", async () => {
    const seller = await createSeller(db, upstream.url, { freeQuota: 1 });
    const buyer = await createBuyer(db, 10_000n);

    const first = await autopay(seller, buyer.rawKey);
    expect(first.status).toBe(200);
    expect(first.headers.has("PAYMENT-RESPONSE")).toBe(false);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);

    const second = await autopay(seller, buyer.rawKey);
    expect(second.status).toBe(200);
    expect(second.headers.has("PAYMENT-RESPONSE")).toBe(true);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("does not charge when the upstream fails", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);

    const res = await autopay(seller, buyer.rawKey);

    expect(res.status).toBe(502);
    const error = (await errorOf(res)) as { callId: string };
    expect(error).toMatchObject({ code: "upstream_failed", refunded: true });
    const settlement = decodeHeaderValue(
      res.headers.get("PAYMENT-RESPONSE")!,
    ) as SettlementResponse;
    expect(settlement).toMatchObject({ success: false, errorReason: "upstream_failed" });
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(0n);
    const rows = await db.select().from(calls).where(eq(calls.agentId, buyer.agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: error.callId,
      status: "refunded",
      amountMicro: 2_000n,
      upstreamStatus: 503,
    });
    expect(await callEntries(db, error.callId)).toHaveLength(0);
  });

  it("treats any value but true as a normal request", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);

    const res = await autopay(seller, buyer.rawKey, "false");

    expect(res.status).toBe(402);
    expect(res.headers.has("PAYMENT-REQUIRED")).toBe(true);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  describe("Idempotency-Key", () => {
    const withKey = (seller: Seller, rawKey: string, idempotencyKey: string) =>
      autopay(seller, rawKey, "true", { "Idempotency-Key": idempotencyKey });

    it("answers a retry of a paid request with 409 and charges once", async () => {
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);
      const before = upstream.requests.length;

      const first = await withKey(seller, buyer.rawKey, "order-1");
      expect(first.status).toBe(200);
      const settlement = decodeHeaderValue(
        first.headers.get("PAYMENT-RESPONSE")!,
      ) as SettlementResponse;

      const retry = await withKey(seller, buyer.rawKey, "order-1");
      expect(retry.status).toBe(409);
      expect(await errorOf(retry)).toMatchObject({
        code: "idempotent_replay",
        callId: settlement.transaction,
        upstreamStatus: 200,
      });
      expect(upstream.requests.length - before).toBe(1);
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    });

    it("charges once for concurrent requests with the same key", async () => {
      upstream.respond((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 200);
      });
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);
      const before = upstream.requests.length;

      const results = await Promise.all(
        [1, 2, 3].map(() => withKey(seller, buyer.rawKey, "order-2")),
      );

      expect(results.map((res) => res.status).sort()).toEqual([200, 409, 409]);
      for (const res of results.filter((r) => r.status === 409)) {
        expect(["idempotency_in_progress", "idempotent_replay"]).toContain(
          ((await errorOf(res)) as { code: string }).code,
        );
      }
      expect(upstream.requests.length - before).toBe(1);
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    });

    it("charges again for a different key, and keys are per agent", async () => {
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);
      const other = await createBuyer(db, 10_000n);

      expect((await withKey(seller, buyer.rawKey, "a")).status).toBe(200);
      expect((await withKey(seller, buyer.rawKey, "b")).status).toBe(200);
      expect((await withKey(seller, other.rawKey, "a")).status).toBe(200);

      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(6_000n);
      expect(await balanceOf(db, { type: "wallet", orgId: other.orgId })).toBe(8_000n);
    });

    it("after an unpaid failure, the same key gets 410 and charges nothing", async () => {
      upstream.respond((_req, res) => {
        res.writeHead(503);
        res.end();
      });
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);

      expect((await withKey(seller, buyer.rawKey, "order-3")).status).toBe(502);
      const retry = await withKey(seller, buyer.rawKey, "order-3");

      expect(retry.status).toBe(410);
      expect(await errorOf(retry)).toMatchObject({ code: "challenge_expired" });
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
      // The failed first request is the only Call: one refunded Call for the key's Challenge.
      const rows = await db.select().from(calls).where(eq(calls.agentId, buyer.agentId));
      expect(rows.map((row) => row.status)).toEqual(["refunded"]);
    });

    it("after insufficient funds, the same key pays once the wallet can cover it", async () => {
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 1_000n);

      expect((await withKey(seller, buyer.rawKey, "order-4")).status).toBe(402);
      await db.insert(ledgerEntries).values({
        txnId: randomUUID(),
        accountType: "wallet",
        orgId: buyer.orgId,
        amountMicro: 9_000n,
        reason: "seed",
        refId: randomUUID(),
      });

      expect((await withKey(seller, buyer.rawKey, "order-4")).status).toBe(200);
      expect((await withKey(seller, buyer.rawKey, "order-4")).status).toBe(409);
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    });

    it("rejects an over-long key with 400", async () => {
      const seller = await createSeller(db, upstream.url);
      const buyer = await createBuyer(db, 10_000n);

      const res = await withKey(seller, buyer.rawKey, "k".repeat(256));

      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: "invalid_request" });
      expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    });
  });
});
