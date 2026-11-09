import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  callEntries,
  createBuyer,
  createSeller,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { calls, challenges } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { availableFunds, balanceOf } from "../ledger";
import { handlePayRequest, type IssuedReceipt } from "../pay";
import { decodeHeaderValue, type PaymentPayload, type PaymentRequired } from "../x402";
import { handleSettleRequest, handleVerifyRequest, supportedResponse } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("facilitator", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** A Challenge paid through the real gateway and pipeline, ready to settle. */
  async function reserved(funded = 10_000n) {
    const seller = await createSeller(db, "http://127.0.0.1:1");
    const buyer = await createBuyer(db, funded);
    const res = await handleGatewayRequest(
      { db, config },
      new Request(`https://piko.test/g/${seller.slug}/history`),
      { seller: seller.slug, path: ["history"] },
    );
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
    const issued = (await payRes.json()) as IssuedReceipt;
    const paymentPayload = decodeHeaderValue(issued.paymentSignature) as PaymentPayload;
    return { seller, buyer, nonce, paymentPayload, requirements: accepts[0]! };
  }

  const post = (body: unknown) =>
    new Request("https://piko.test/api/facilitator/x", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const verify = (body: unknown) => handleVerifyRequest({ db, config }, post(body));
  const settle = (body: unknown) => handleSettleRequest({ db, config }, post(body));

  function request(payment: Awaited<ReturnType<typeof reserved>>) {
    return {
      x402Version: 2,
      paymentPayload: payment.paymentPayload,
      paymentRequirements: payment.requirements,
    };
  }

  it("lists the supported kinds with the x402 v2 shape", () => {
    expect(supportedResponse(config)).toEqual({
      kinds: [{ x402Version: 2, scheme: "paypal-ledger", network: "paypal:sandbox" }],
      extensions: [],
      signers: {},
    });
  });

  it("verify is read-only: it can run twice and consumes nothing", async () => {
    const payment = await reserved();

    for (let i = 0; i < 2; i++) {
      const res = await verify(request(payment));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ isValid: true, payer: payment.buyer.agentId });
    }

    const [challenge] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.nonce, payment.nonce));
    expect(challenge!.consumedAt).toBeNull();
    expect(challenge!.reservedAt).not.toBeNull();
    expect(await db.select().from(calls).where(eq(calls.nonce, payment.nonce))).toHaveLength(0);
    expect(await availableFunds(db, payment.buyer.orgId)).toBe(8_000n);
    expect(await balanceOf(db, { type: "wallet", orgId: payment.buyer.orgId })).toBe(10_000n);
  });

  it("verify reports a tampered payload and mismatched requirements", async () => {
    const payment = await reserved();

    const tampered = await verify({
      ...request(payment),
      paymentPayload: {
        ...payment.paymentPayload,
        accepted: { ...payment.paymentPayload.accepted, amount: "1" },
      },
    });
    await expect(tampered.json()).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_receipt",
    });

    const wrongRequirements = await verify({
      ...request(payment),
      paymentRequirements: { ...payment.requirements, payTo: "someone-else" },
    });
    await expect(wrongRequirements.json()).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_receipt",
    });
  });

  it("verify reports challenge_expired for a used Receipt", async () => {
    const payment = await reserved();
    await db
      .update(challenges)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(eq(challenges.nonce, payment.nonce));

    const res = await verify(request(payment));

    await expect(res.json()).resolves.toMatchObject({
      isValid: false,
      invalidReason: "challenge_expired",
    });
  });

  it("settles a Call: Ledger entries, Call row, and a SettlementResponse", async () => {
    const payment = await reserved();

    const res = await settle(request(payment));

    expect(res.status).toBe(200);
    const settlement = (await res.json()) as { transaction: string };
    expect(settlement).toMatchObject({
      success: true,
      network: "paypal:sandbox",
      payer: payment.buyer.agentId,
      amount: "2000",
    });

    const entries = await callEntries(db, settlement.transaction);
    expect(entries.map((entry) => entry.amountMicro)).toEqual([-2_000n, 1_900n, 100n]);

    const [row] = await db.select().from(calls).where(eq(calls.nonce, payment.nonce));
    expect(row).toMatchObject({
      id: settlement.transaction,
      status: "paid",
      amountMicro: 2_000n,
      upstreamStatus: null,
    });
    expect(await balanceOf(db, { type: "wallet", orgId: payment.buyer.orgId })).toBe(8_000n);
  });

  it("settle returns 410 for a Receipt that was already used", async () => {
    const payment = await reserved();

    expect((await settle(request(payment))).status).toBe(200);
    const second = await settle(request(payment));

    expect(second.status).toBe(410);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "challenge_expired" },
    });
    expect(await balanceOf(db, { type: "wallet", orgId: payment.buyer.orgId })).toBe(8_000n);
  });

  it("settle returns success false for a tampered payment, charging nothing", async () => {
    const payment = await reserved();

    const res = await settle({
      ...request(payment),
      paymentPayload: {
        ...payment.paymentPayload,
        accepted: { ...payment.paymentPayload.accepted, amount: "1" },
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      errorReason: "invalid_receipt",
      transaction: "",
      network: "paypal:sandbox",
    });
    expect(await balanceOf(db, { type: "wallet", orgId: payment.buyer.orgId })).toBe(10_000n);
  });

  it("rejects malformed bodies with 400", async () => {
    for (const body of ["not json", { x402Version: 1 }, { x402Version: 2, paymentPayload: {} }]) {
      expect((await verify(body)).status).toBe(400);
      expect((await settle(body)).status).toBe(400);
    }
  });

  it("verify rejects a payload with the wrong shape", async () => {
    const res = await verify({
      x402Version: 2,
      paymentPayload: { nothing: "here" },
      paymentRequirements: {},
    });
    await expect(res.json()).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_receipt",
    });
  });
});
