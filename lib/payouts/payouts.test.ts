import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { stubGatewayEnv } from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { ledgerEntries, orgs, payouts } from "../db/schema";
import { balanceOf, postCall } from "../ledger";
import { PayPalClient } from "../paypal";
import { maybeAutoPayout, PayoutError, sendPayout } from "./index";

const url = inject("testDatabaseUrl");
const THRESHOLD = 1_000_000n;

interface SentBatch {
  requestId: string | null;
  body: {
    sender_batch_header: { sender_batch_id: string };
    items: { amount: { value: string; currency: string }; receiver: string }[];
  };
}

/** A PayPal client whose fetch answers the token call and records each payout batch. */
function fakePayPal(
  answer: { status: number; body: unknown } | "network-error" = {
    status: 201,
    body: { batch_header: { payout_batch_id: "BATCH-1", batch_status: "PENDING" } },
  },
) {
  const sent: SentBatch[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (target.endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: "token", expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    sent.push({
      requestId: headers.get("PayPal-Request-Id"),
      body: JSON.parse(String(init?.body)),
    });
    if (answer === "network-error") throw new TypeError("fetch failed");
    return Response.json(answer.body, { status: answer.status });
  }) as typeof fetch;
  const paypal = new PayPalClient({
    baseUrl: "https://paypal.test",
    clientId: "id",
    clientSecret: "secret",
    fetch: fetchImpl,
  });
  return { paypal, sent };
}

describe.skipIf(!url)("Payouts", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** A seller (with a PayPal email unless told otherwise) holding `balance` micro-USD. */
  async function seller(balance: bigint, email: string | null = "priya@piko.test") {
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Priya",
        slug: `seller-${randomUUID()}`,
        kind: "personal",
        billing: "prepaid",
        paypalEmail: email,
      })
      .returning({ id: orgs.id });
    if (balance > 0n) await credit(org!.id, balance);
    return org!.id;
  }

  async function credit(orgId: string, amountMicro: bigint) {
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "seller",
      orgId,
      amountMicro,
      reason: "seed",
      refId: randomUUID(),
    });
  }

  const sellerBalance = (orgId: string) => balanceOf(db, { type: "seller", orgId });

  it("sends one item for the whole cents, writes a pending debit and stores the batch id", async () => {
    const orgId = await seller(1_234_567n);
    const { paypal, sent } = fakePayPal();

    const payout = await sendPayout({ db, paypal }, orgId, "manual");

    expect(payout).toMatchObject({
      amountMicro: 1_230_000n,
      status: "pending",
      paypalBatchId: "BATCH-1",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.requestId).toBe(payout.id);
    expect(sent[0]!.body.sender_batch_header.sender_batch_id).toBe(payout.id);
    expect(sent[0]!.body.items).toEqual([
      expect.objectContaining({
        amount: { value: "1.23", currency: "USD" },
        receiver: "priya@piko.test",
      }),
    ]);
    // The fraction of a cent stays behind.
    expect(await sellerBalance(orgId)).toBe(4_567n);
    const debits = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, payout.id));
    expect(debits).toEqual([
      expect.objectContaining({
        reason: "payout",
        accountType: "seller",
        amountMicro: -1_230_000n,
      }),
    ]);
    const [row] = await db.select().from(payouts).where(eq(payouts.id, payout.id));
    expect(row).toMatchObject({ status: "pending", paypalBatchId: "BATCH-1" });
  });

  it("pays out on its own when a settle takes Priya from $0.94 past $1.00", async () => {
    const orgId = await seller(940_000n);
    const { paypal, sent } = fakePayPal();

    // Under the threshold: nothing happens.
    expect(await maybeAutoPayout({ db, paypal, thresholdMicro: THRESHOLD }, orgId)).toBeNull();
    expect(sent).toHaveLength(0);

    // A Call pays Priya about $0.07 after the fee, taking her past $1.00.
    const buyer = await seller(0n, null);
    await postCall(db, {
      callId: randomUUID(),
      buyerOrgId: buyer,
      sellerOrgId: orgId,
      priceMicro: 73_700n,
    });
    const balance = await sellerBalance(orgId);
    expect(balance).toBeGreaterThanOrEqual(THRESHOLD);

    const payout = await maybeAutoPayout({ db, paypal, thresholdMicro: THRESHOLD }, orgId);
    const wholeCents = (balance / 10_000n) * 10_000n;
    expect(payout).toMatchObject({ amountMicro: wholeCents, paypalBatchId: "BATCH-1" });
    expect(sent).toHaveLength(1);
    expect(await sellerBalance(orgId)).toBe(balance - wholeCents);

    // The balance is now under the threshold, so the next settle pays nothing more.
    expect(await maybeAutoPayout({ db, paypal, thresholdMicro: THRESHOLD }, orgId)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("concurrent payouts for one seller pay the balance once", async () => {
    const orgId = await seller(2_000_000n);
    const { paypal, sent } = fakePayPal();
    const results = await Promise.allSettled([
      sendPayout({ db, paypal }, orgId, "manual"),
      sendPayout({ db, paypal }, orgId, "manual"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "nothing_to_pay" }),
    });
    expect(sent).toHaveLength(1);
    expect(await sellerBalance(orgId)).toBe(0n);
  });

  it("a PayPal refusal reverses the debit and marks the payout failed", async () => {
    const orgId = await seller(1_500_000n);
    const { paypal } = fakePayPal({
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", message: "Receiver is unregistered", debug_id: "d1" },
    });
    await expect(sendPayout({ db, paypal }, orgId, "manual")).rejects.toMatchObject({
      code: "paypal_refused",
    });
    expect(await sellerBalance(orgId)).toBe(1_500_000n);
    const [row] = await db.select().from(payouts).where(eq(payouts.sellerOrgId, orgId));
    expect(row!.status).toBe("failed");
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, row!.id));
    expect(entries.map((e) => [e.reason, e.amountMicro]).sort()).toEqual([
      ["payout", -1_500_000n],
      ["payout_reversal", 1_500_000n],
    ]);
  });

  it("an unknown outcome keeps the debit and leaves the payout pending", async () => {
    const orgId = await seller(1_000_000n);
    const { paypal } = fakePayPal("network-error");
    const payout = await sendPayout({ db, paypal }, orgId, "manual");
    expect(payout).toMatchObject({ status: "pending", paypalBatchId: null });
    expect(await sellerBalance(orgId)).toBe(0n);
  });

  it("refuses with no PayPal email, nothing to pay, or under the threshold for auto", async () => {
    const { paypal, sent } = fakePayPal();
    await expect(
      sendPayout({ db, paypal }, await seller(2_000_000n, null), "manual"),
    ).rejects.toMatchObject({ code: "no_paypal_email" });
    await expect(sendPayout({ db, paypal }, await seller(9_999n), "manual")).rejects.toBeInstanceOf(
      PayoutError,
    );
    await expect(
      sendPayout({ db, paypal, thresholdMicro: THRESHOLD }, await seller(999_999n), "auto"),
    ).rejects.toMatchObject({ code: "below_threshold" });
    expect(sent).toHaveLength(0);
  });
});
