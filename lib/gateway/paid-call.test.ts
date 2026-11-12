import { eq, sql } from "drizzle-orm";
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
import { calls, challenges } from "../db/schema";
import { availableFunds, balanceOf, reserveFunds } from "../ledger";
import { handlePayRequest, type IssuedReceipt } from "../pay";
import {
  decodeHeaderValue,
  encodeHeaderValue,
  type PaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "../x402";
import { signReceipt, verifyReceipt } from "../x402/receipt";
import { handleGatewayRequest, type GatewayConfig } from "./index";
import { refundPayment, settlePayment } from "./settlement";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: paid retry", () => {
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

  function call(
    seller: Seller,
    init: {
      signature?: string;
      config?: GatewayConfig;
      method?: string;
      body?: string;
      query?: string;
      request?: Request;
    } = {},
  ) {
    const headers: Record<string, string> = init.signature
      ? { "PAYMENT-SIGNATURE": init.signature }
      : {};
    return handleGatewayRequest(
      { db, config: init.config ?? config },
      init.request ??
        gatewayRequest(
          init.method ?? "GET",
          `https://piko.test/g/${seller.slug}${seller.path}${init.query ?? ""}`,
          { headers, body: init.body },
        ),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
  }

  function pay(key: string, nonce: string) {
    return handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce }),
      }),
    );
  }

  /** Runs the real loop up to a Receipt: 402, then POST /api/pay. */
  async function paidReceipt(seller: Seller, key: string, method = "GET") {
    const res = await call(seller, { method, body: method === "GET" ? undefined : "{}" });
    const { accepts } = (await res.json()) as PaymentRequired;
    const nonce = accepts[0]!.extra.nonce;
    const payRes = await pay(key, nonce);
    expect(payRes.status).toBe(200);
    return { nonce, issued: (await payRes.json()) as IssuedReceipt };
  }

  /** A request whose body sends one chunk and then stalls, like a slow upload. */
  function stalledUpload(seller: Seller, signature: string): Request {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":'));
      },
    });
    return new Request(`https://piko.test/g/${seller.slug}${seller.path}`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": signature, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
  }

  const settlementOf = (res: Response) =>
    decodeHeaderValue(res.headers.get("PAYMENT-RESPONSE")!) as SettlementResponse;
  const errorOf = async (res: Response) => ((await res.json()) as { error: object }).error;
  const claimsOf = (issued: IssuedReceipt) => {
    const verified = verifyReceipt(issued.receipt, config.receiptSigningSecret);
    if (!verified.ok) throw new Error("receipt should verify");
    return verified.claims;
  };

  it("forwards a paid retry, settles the ledger and returns PAYMENT-RESPONSE", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    const before = upstream.requests.length;

    const res = await call(seller, { signature: issued.paymentSignature, query: "?product=abc" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(upstream.requests.length - before).toBe(1);
    expect(upstream.requests.at(-1)!.url).toBe("/history?product=abc");
    expect(upstream.requests.at(-1)!.headers["payment-signature"]).toBeUndefined();

    const settlement = settlementOf(res);
    expect(settlement).toMatchObject({
      success: true,
      network: "paypal:sandbox",
      payer: buyer.agentId,
      amount: "2000",
    });

    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(row).toMatchObject({
      id: settlement.transaction,
      agentId: buyer.agentId,
      buyerOrgId: buyer.orgId,
      endpointId: seller.endpointId,
      amountMicro: 2_000n,
      status: "paid",
      upstreamStatus: 200,
      simulated: false,
    });

    const entries = await callEntries(db, settlement.transaction);
    expect(entries.map((entry) => entry.amountMicro)).toEqual([-2_000n, 1_900n, 100n]);
    expect(entries.map((entry) => entry.accountType)).toEqual(["wallet", "seller", "platform"]);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(1_900n);
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);

    const [challenge] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(challenge!.consumedAt).not.toBeNull();
  });

  it("forwards a POST body to the upstream", async () => {
    const seller = await createSeller(db, upstream.url, { method: "POST", path: "/summarise" });
    const buyer = await createBuyer(db, 10_000n);
    const res = await call(seller, { method: "POST", body: "{}" });
    const { accepts } = (await res.json()) as PaymentRequired;
    const nonce = accepts[0]!.extra.nonce;
    const payRes = await handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${buyer.rawKey}` },
        body: JSON.stringify({ nonce }),
      }),
    );
    const { paymentSignature } = (await payRes.json()) as IssuedReceipt;

    const paid = await call(seller, {
      method: "POST",
      signature: paymentSignature,
      body: '{"text":"hello"}',
    });

    expect(paid.status).toBe(200);
    expect(upstream.requests.at(-1)).toMatchObject({ method: "POST", body: '{"text":"hello"}' });
  });

  it("rejects a reused Receipt, without calling upstream or charging again", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);

    expect((await call(seller, { signature: issued.paymentSignature })).status).toBe(200);
    const before = upstream.requests.length;

    const reused = await call(seller, { signature: issued.paymentSignature });

    expect(reused.status).toBe(410);
    expect(await errorOf(reused)).toMatchObject({ code: "challenge_expired" });
    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("charges once and forwards once for concurrent requests with one Receipt", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);
    const before = upstream.requests.length;

    const results = await Promise.all(
      [1, 2, 3].map(() => call(seller, { signature: issued.paymentSignature })),
    );

    expect(results.map((res) => res.status).sort()).toEqual([200, 410, 410]);
    expect(upstream.requests.length - before).toBe(1);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("rejects a tampered amount, in the Receipt and in accepted", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);
    const payload = decodeHeaderValue(issued.paymentSignature) as PaymentPayload;
    const [header, body, signature] = issued.receipt.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as object;
    const before = upstream.requests.length;

    const tamperedReceipt = `${header}.${Buffer.from(
      JSON.stringify({ ...claims, amount: "1" }),
    ).toString("base64url")}.${signature}`;
    const changedReceipt = await call(seller, {
      signature: encodeHeaderValue({ ...payload, payload: { receipt: tamperedReceipt } }),
    });
    expect(changedReceipt.status).toBe(402);
    expect(await errorOf(changedReceipt)).toMatchObject({ code: "invalid_receipt" });

    const changedAccepted = await call(seller, {
      signature: encodeHeaderValue({
        ...payload,
        accepted: { ...payload.accepted, amount: "1" },
      }),
    });
    expect(changedAccepted.status).toBe(402);
    expect(await errorOf(changedAccepted)).toMatchObject({ code: "invalid_receipt" });

    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("rejects a Receipt signed with another secret", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);
    const payload = decodeHeaderValue(issued.paymentSignature) as PaymentPayload;
    const verification = verifyReceipt(issued.receipt, config.receiptSigningSecret);
    if (!verification.ok) throw new Error("unreachable");
    const forged = signReceipt(verification.claims, "another-secret");

    const res = await call(seller, {
      signature: encodeHeaderValue({ ...payload, payload: { receipt: forged } }),
    });

    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects a Receipt used on a different endpoint", async () => {
    const seller = await createSeller(db, upstream.url);
    const other = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(other, { signature: issued.paymentSignature });

    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: "invalid_receipt" });
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);
  });

  it("rejects a garbage PAYMENT-SIGNATURE", async () => {
    const seller = await createSeller(db, upstream.url);
    for (const signature of ["not-base64-json", encodeHeaderValue({ x402Version: 2 })]) {
      const res = await call(seller, { signature });
      expect(res.status).toBe(402);
      expect(await errorOf(res)).toMatchObject({ code: "invalid_receipt" });
    }
  });

  it("returns 410 for a Receipt past its expiry", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);
    const payload = decodeHeaderValue(issued.paymentSignature) as PaymentPayload;
    const verification = verifyReceipt(issued.receipt, config.receiptSigningSecret);
    if (!verification.ok) throw new Error("unreachable");
    const past = signReceipt(
      { ...verification.claims, exp: Math.floor(Date.now() / 1000) - 1 },
      config.receiptSigningSecret,
    );

    const res = await call(seller, {
      signature: encodeHeaderValue({ ...payload, payload: { receipt: past } }),
    });

    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_expired" });
  });

  it("returns 410 when the reservation has ended, without forwarding", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    await db
      .update(challenges)
      .set({ reservationExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(challenges.nonce, nonce));
    const before = upstream.requests.length;

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(410);
    expect(upstream.requests.length).toBe(before);
  });

  it("does not charge on an upstream 500, and releases the reservation", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(502);
    const error = (await errorOf(res)) as { callId: string };
    expect(error).toMatchObject({ code: "upstream_failed", refunded: true });
    expect(settlementOf(res)).toEqual({
      success: false,
      errorReason: "upstream_failed",
      transaction: "",
      network: "paypal:sandbox",
    });
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(0n);
    const rows = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: error.callId,
      status: "refunded",
      amountMicro: 2_000n,
      agentId: buyer.agentId,
      buyerOrgId: buyer.orgId,
      upstreamStatus: 500,
    });
    expect(rows[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await callEntries(db, error.callId)).toHaveLength(0);

    const retry = await call(seller, { signature: issued.paymentSignature });
    expect(retry.status).toBe(410);
  });

  it("does not charge on an upstream timeout", async () => {
    upstream.respond(() => {
      // Never answers.
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(seller, {
      signature: issued.paymentSignature,
      config: { ...config, upstreamTimeoutMs: 100 },
    });

    expect(res.status).toBe(502);
    const error = (await errorOf(res)) as { callId: string };
    expect(error).toMatchObject({ code: "upstream_failed", refunded: true });
    expect(settlementOf(res)).toMatchObject({ success: false, errorReason: "upstream_failed" });
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    expect(await balanceOf(db, { type: "seller", orgId: seller.orgId })).toBe(0n);
    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    // No upstream status: a timeout is recorded as null.
    expect(row).toMatchObject({ id: error.callId, status: "refunded", upstreamStatus: null });
    expect(row!.latencyMs).toBeGreaterThanOrEqual(100);
    expect(await callEntries(db, error.callId)).toHaveLength(0);
  });

  it("refunds when the upstream can't be reached at all", async () => {
    const seller = await createSeller(db, "http://127.0.0.1:1");
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(502);
    expect(await errorOf(res)).toMatchObject({ code: "upstream_failed", refunded: true });
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(row).toMatchObject({ status: "refunded", upstreamStatus: null });
  });

  it("records one refunded Call per Challenge, however often the refund runs", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    expect((await call(seller, { signature: issued.paymentSignature })).status).toBe(502);

    const again = await refundPayment(db, claimsOf(issued), { upstreamStatus: 503, latencyMs: 1 });

    expect(again).toBeNull();
    expect(await db.select().from(calls).where(eq(calls.nonce, nonce))).toHaveLength(1);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("does not refund a Receipt the facilitator settled while the upstream was failing", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    upstream.respond((_req, res) => {
      // Settle through the facilitator while the gateway waits on the upstream.
      void settlePayment(db, config, claimsOf(issued)).then(() => {
        res.writeHead(500);
        res.end();
      });
    });

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_expired" });
    const rows = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("paid");
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("settles and passes through a 4xx from the upstream", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ missing: true }));
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ missing: true });
    expect(settlementOf(res).success).toBe(true);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(row).toMatchObject({ status: "paid", upstreamStatus: 404 });
    expect(await callEntries(db, row!.id)).toHaveLength(3);
  });

  it("settles a 400 from the upstream as paid, with three Ledger entries", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ bad: true }));
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(400);
    expect(settlementOf(res).success).toBe(true);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(row).toMatchObject({ status: "paid", upstreamStatus: 400 });
    expect(await callEntries(db, row!.id)).toHaveLength(3);
  });

  it("passes through a 204 with no body", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey);

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(204);
    expect(settlementOf(res).success).toBe(true);
  });

  it("forwards exactly once when many requests race with one Receipt", async () => {
    const seller = await createSeller(db, upstream.url, { method: "POST", path: "/summarise" });
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey, "POST");
    const before = upstream.requests.length;

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call(seller, {
          method: "POST",
          signature: issued.paymentSignature,
          body: JSON.stringify({ attempt: i }),
        }),
      ),
    );

    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 410)).toHaveLength(11);
    expect(upstream.requests.length - before).toBe(1);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("forwards exactly once when two gateway processes get the same Receipt", async () => {
    upstream.respond((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
    const seller = await createSeller(db, upstream.url, { method: "POST", path: "/summarise" });
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey, "POST");
    // A fresh copy of the module shares nothing in memory, like a second server process.
    vi.resetModules();
    const other = await import("./index");
    const before = upstream.requests.length;

    const request = () =>
      gatewayRequest("POST", `https://piko.test/g/${seller.slug}${seller.path}`, {
        headers: { "PAYMENT-SIGNATURE": issued.paymentSignature },
        body: '{"text":"hello"}',
      });
    const params = { seller: seller.slug, path: seller.path.slice(1).split("/") };
    const results = await Promise.all([
      handleGatewayRequest({ db, config }, request(), params),
      other.handleGatewayRequest({ db, config }, request(), params),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 410]);
    expect(upstream.requests.length - before).toBe(1);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
  });

  it("does not let a Challenge be paid again after an upstream failure", async () => {
    upstream.respond((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    expect((await call(seller, { signature: issued.paymentSignature })).status).toBe(502);
    upstream.respond((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const before = upstream.requests.length;

    const repay = await pay(buyer.rawKey, nonce);
    expect(repay.status).toBe(410);
    expect(await errorOf(repay)).toMatchObject({ code: "challenge_expired" });

    const reused = await call(seller, { signature: issued.paymentSignature });
    expect(reused.status).toBe(410);
    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
  });

  it("rejects a Receipt from an earlier hold once the Challenge is reserved again", async () => {
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    // The first hold ends without settling, then the same Challenge is reserved again.
    await db
      .update(challenges)
      .set({ reservationExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(challenges.nonce, nonce));
    await reserveFunds(db, {
      nonce,
      agentId: buyer.agentId,
      buyerOrgId: buyer.orgId,
      ttlSeconds: config.receiptTtlSeconds * 2,
    });
    const before = upstream.requests.length;

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_expired" });
    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
  });

  it("gives up on a slow upload without calling upstream, and releases the hold", async () => {
    const seller = await createSeller(db, upstream.url, { method: "POST", path: "/summarise" });
    const buyer = await createBuyer(db, 10_000n);
    const { issued } = await paidReceipt(seller, buyer.rawKey, "POST");
    const before = upstream.requests.length;

    const res = await call(seller, {
      request: stalledUpload(seller, issued.paymentSignature),
      config: { ...config, bodyTimeoutMs: 200 },
    });

    expect(res.status).toBe(408);
    expect(await errorOf(res)).toMatchObject({ code: "request_timeout" });
    expect(upstream.requests.length).toBe(before);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(10_000n);
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
    const retry = await call(seller, {
      method: "POST",
      signature: issued.paymentSignature,
      body: "{}",
    });
    expect(retry.status).toBe(410);
    expect(upstream.requests.length).toBe(before);
  });

  it("still settles when the upstream outlasts the Receipt's original hold", async () => {
    upstream.respond((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 1_500);
    });
    const seller = await createSeller(db, upstream.url);
    const buyer = await createBuyer(db, 10_000n);
    const { nonce, issued } = await paidReceipt(seller, buyer.rawKey);
    // Leave the hold one second, shorter than the upstream takes.
    await db
      .update(challenges)
      .set({ reservationExpiresAt: sql`clock_timestamp() + interval '1 second'` })
      .where(eq(challenges.nonce, nonce));

    const res = await call(seller, { signature: issued.paymentSignature });

    expect(res.status).toBe(200);
    expect(settlementOf(res).success).toBe(true);
    expect(await balanceOf(db, { type: "wallet", orgId: buyer.orgId })).toBe(8_000n);
    const [row] = await db.select().from(calls).where(eq(calls.nonce, nonce));
    expect(row).toMatchObject({ status: "paid" });
  });
});
