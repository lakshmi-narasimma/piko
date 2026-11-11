/**
 * Wallet top-ups: create a PayPal Order, then credit the Wallet once PayPal has captured it.
 * This is one of the few places money enters Piko (docs/DESIGN.md section 13). Crediting is
 * idempotent on the PayPal capture id, so the capture route, a page refresh and the
 * PAYMENT.CAPTURE.COMPLETED webhook can all race and the Wallet is still credited once.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { ledgerEntries, topups } from "../db/schema";
import { balanceOf, type DbOrTx } from "../ledger";
import { isDuplicateEvent } from "../ledger/errors";
import type { MicroUsd } from "../money";
import {
  captureOrder,
  createOrder,
  fromPayPalValue,
  getOrder,
  PayPalError,
  type PayPalClient,
  type PayPalOrder,
} from "../paypal";

export const MIN_TOPUP_MICRO = 1_000_000n;
export const MAX_TOPUP_MICRO = 500_000_000n;

export type TopupErrorCode =
  "invalid_amount" | "topup_not_found" | "not_approved" | "capture_missing" | "amount_mismatch";

export class TopupError extends Error {
  constructor(
    public readonly code: TopupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TopupError";
  }
}

export interface CreatedTopup {
  topupId: string;
  orderId: string;
}

/** Creates the PayPal Order and our own `topups` row for it. */
export async function createTopup(
  db: Db,
  paypal: PayPalClient,
  input: { orgId: string; amountMicro: MicroUsd },
): Promise<CreatedTopup> {
  const { orgId, amountMicro } = input;
  if (amountMicro < MIN_TOPUP_MICRO || amountMicro > MAX_TOPUP_MICRO) {
    throw new TopupError("invalid_amount", "Top up between $1.00 and $500.00.");
  }
  if (amountMicro % 10_000n !== 0n) {
    throw new TopupError("invalid_amount", "Top up a whole number of cents.");
  }

  const topupId = randomUUID();
  // Our row id is the request id, so a retried create can't open a second order.
  const order = await createOrder(paypal, {
    amountMicro,
    requestId: `topup-${topupId}`,
    description: "Piko wallet top-up",
  });
  await db.insert(topups).values({ id: topupId, orgId, paypalOrderId: order.id, amountMicro });
  return { topupId, orderId: order.id };
}

export interface CompleteTopupInput {
  orderId: string;
  captureId: string;
  /** What PayPal says it captured. */
  paidMicro: MicroUsd;
}

export interface TopupResult {
  /** True only for the call that actually credited the Wallet. */
  credited: boolean;
  orgId: string;
  amountMicro: bigint;
}

/**
 * Marks the top-up completed and credits the Wallet, in one transaction. Safe to call any
 * number of times, from any number of places: the topups row is locked, and the Ledger's
 * unique index on (reason, ref_id, account) is the backstop.
 */
export async function completeTopup(db: Db, input: CompleteTopupInput): Promise<TopupResult> {
  return db.transaction(async (tx) => {
    const [topup] = await tx
      .select()
      .from(topups)
      .where(eq(topups.paypalOrderId, input.orderId))
      .for("update");
    if (!topup) {
      throw new TopupError("topup_not_found", `No top-up for PayPal order ${input.orderId}.`);
    }
    const result = { orgId: topup.orgId, amountMicro: topup.amountMicro };
    if (topup.status === "completed") return { ...result, credited: false };

    if (input.paidMicro !== topup.amountMicro) {
      throw new TopupError(
        "amount_mismatch",
        `PayPal captured ${input.paidMicro} micro-USD for a ${topup.amountMicro} micro-USD top-up.`,
      );
    }

    try {
      // A savepoint, so a duplicate leaves this transaction usable.
      await tx.transaction((inner) =>
        inner.insert(ledgerEntries).values({
          txnId: randomUUID(),
          accountType: "wallet",
          orgId: topup.orgId,
          amountMicro: topup.amountMicro,
          reason: "topup",
          refId: input.captureId,
        }),
      );
    } catch (error) {
      if (!isDuplicateEvent(error)) throw error;
      // Credited already (the row just hadn't caught up): only record the state.
      await tx
        .update(topups)
        .set({ status: "completed", paypalCaptureId: input.captureId })
        .where(eq(topups.id, topup.id));
      return { ...result, credited: false };
    }

    await tx
      .update(topups)
      .set({ status: "completed", paypalCaptureId: input.captureId })
      .where(eq(topups.id, topup.id));
    return { ...result, credited: true };
  });
}

export interface CaptureResult extends TopupResult {
  /** PayPal accepted the capture but hasn't completed it; the webhook will credit it. */
  pending: boolean;
  balanceMicro: bigint;
}

function firstCapture(order: PayPalOrder) {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}

/**
 * Captures the approved order and credits the Wallet. `orgId` must own the top-up, so one
 * org can't capture, or probe, another's order.
 */
export async function captureTopup(
  db: Db,
  paypal: PayPalClient,
  input: { orgId: string; orderId: string },
): Promise<CaptureResult> {
  const [topup] = await db
    .select()
    .from(topups)
    .where(and(eq(topups.paypalOrderId, input.orderId), eq(topups.orgId, input.orgId)));
  if (!topup) throw new TopupError("topup_not_found", "No such top-up.");

  const balance = (orgId: string) => balanceOf(db as DbOrTx, { type: "wallet", orgId });
  if (topup.status === "completed") {
    return {
      credited: false,
      pending: false,
      orgId: topup.orgId,
      amountMicro: topup.amountMicro,
      balanceMicro: await balance(topup.orgId),
    };
  }

  let order: PayPalOrder;
  try {
    order = await captureOrder(paypal, input.orderId);
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error;
    if (error.issues.some((issue) => issue.startsWith("ORDER_ALREADY_CAPTURED"))) {
      order = await getOrder(paypal, input.orderId);
    } else if (error.status === 422) {
      // The buyer closed the popup or never approved: nothing was captured.
      throw new TopupError("not_approved", "The payment wasn't approved in PayPal.");
    } else {
      throw error;
    }
  }

  const capture = firstCapture(order);
  if (!capture) throw new TopupError("capture_missing", "PayPal returned no capture.");
  if (capture.status !== "COMPLETED" || capture.amount.currency_code !== "USD") {
    return {
      credited: false,
      pending: capture.status !== "DECLINED" && capture.status !== "FAILED",
      orgId: topup.orgId,
      amountMicro: topup.amountMicro,
      balanceMicro: await balance(topup.orgId),
    };
  }

  const done = await completeTopup(db, {
    orderId: input.orderId,
    captureId: capture.id,
    paidMicro: fromPayPalValue(capture.amount.value),
  });
  return { ...done, pending: false, balanceMicro: await balance(done.orgId) };
}
