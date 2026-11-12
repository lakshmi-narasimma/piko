/**
 * Seller Payouts (DESIGN.md section 7.3): a PayPal Payouts batch with one item to the
 * seller's PayPal email.
 *
 * Order of work, so money can never be paid twice:
 * 1. Under the seller org's lock, read the seller balance, write the `payouts` row and a
 *    pending Ledger debit (reason `payout`, ref the payout id), in one transaction.
 * 2. Send the batch. The payout id is both `sender_batch_id` and `PayPal-Request-Id`, so a
 *    retry of the same payout returns the same batch instead of paying again.
 * 3. Store PayPal's batch id. If PayPal definitely refused (a 4xx), mark the payout failed
 *    and write the reversing entry (reason `payout_reversal`); the unique ledger index
 *    allows that once. If the outcome is unknown (network error or 5xx), the debit stands
 *    and the payout stays pending for the payout webhooks (P6-04) to settle or reverse.
 *
 * PayPal only takes whole cents, so a payout sends the balance rounded down to a cent; the
 * fraction stays on the seller balance for next time.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { ledgerEntries, orgs, payouts } from "../db/schema";
import { getEnv } from "../env";
import { balanceOf } from "../ledger";
import { formatUsd, type MicroUsd } from "../money";
import { getPayPal, PayPalError, toPayPalValue, type PayPalClient } from "../paypal";

const MICRO_PER_CENT = 10_000n;

export type PayoutTrigger = "auto" | "manual";

export class PayoutError extends Error {
  constructor(
    public readonly code:
      "no_paypal_email" | "nothing_to_pay" | "below_threshold" | "paypal_refused",
    message: string,
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

export interface Payout {
  id: string;
  amountMicro: MicroUsd;
  status: "pending" | "settled" | "failed";
  paypalBatchId: string | null;
}

interface PayoutDeps {
  db: Db;
  /** Injected in tests. Defaults to the app's sandbox client. */
  paypal?: PayPalClient;
  thresholdMicro?: MicroUsd;
}

/** Step 1: the payouts row and the pending debit, under the seller org's lock. */
function reservePayout(
  db: Db,
  sellerOrgId: string,
  trigger: PayoutTrigger,
  thresholdMicro: MicroUsd,
): Promise<{ id: string; amountMicro: MicroUsd; email: string }> {
  return db.transaction(async (tx) => {
    // Serialises payouts per seller. NO KEY UPDATE, like the ledger's org lock, so it never
    // blocks the key-share locks that Calls posting to this seller take.
    const [org] = await tx
      .select({ email: orgs.paypalEmail })
      .from(orgs)
      .where(eq(orgs.id, sellerOrgId))
      .for("no key update");
    if (!org?.email) {
      throw new PayoutError("no_paypal_email", "Add a PayPal email before withdrawing.");
    }

    const balance = await balanceOf(tx, { type: "seller", orgId: sellerOrgId });
    if (trigger === "auto" && balance < thresholdMicro) {
      throw new PayoutError(
        "below_threshold",
        `The balance is under the ${formatUsd(thresholdMicro)} payout threshold.`,
      );
    }
    const amountMicro = (balance / MICRO_PER_CENT) * MICRO_PER_CENT;
    if (amountMicro <= 0n) {
      throw new PayoutError("nothing_to_pay", "There is less than a cent to withdraw.");
    }

    const id = randomUUID();
    await tx.insert(payouts).values({ id, sellerOrgId, amountMicro, status: "pending" });
    await tx.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "seller",
      orgId: sellerOrgId,
      amountMicro: -amountMicro,
      reason: "payout",
      refId: id,
    });
    return { id, amountMicro, email: org.email };
  });
}

/** Step 3 on a definite refusal: mark it failed and put the money back, once. */
async function reversePayout(
  db: Db,
  payout: { id: string; amountMicro: MicroUsd },
  sellerOrgId: string,
) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(payouts)
      .set({ status: "failed" })
      .where(and(eq(payouts.id, payout.id), eq(payouts.status, "pending")))
      .returning({ id: payouts.id });
    if (!row) return; // Already settled or reversed elsewhere.
    await tx
      .insert(ledgerEntries)
      .values({
        txnId: randomUUID(),
        accountType: "seller",
        orgId: sellerOrgId,
        amountMicro: payout.amountMicro,
        reason: "payout_reversal",
        refId: payout.id,
      })
      .onConflictDoNothing();
  });
}

interface CreateBatchResponse {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
}

/**
 * Pays the seller's balance out to their PayPal email. `auto` runs only at or above the
 * payout threshold; `manual` (the Withdraw button) pays any whole-cent balance.
 *
 * @throws PayoutError when there is no email, nothing to pay, the balance is under the
 *   threshold (auto), or PayPal refused the batch (the debit is then reversed).
 */
export async function sendPayout(
  deps: PayoutDeps,
  sellerOrgId: string,
  trigger: PayoutTrigger,
): Promise<Payout> {
  const { db } = deps;
  const threshold = deps.thresholdMicro ?? getEnv().PAYOUT_THRESHOLD_MICRO;
  const reserved = await reservePayout(db, sellerOrgId, trigger, threshold);
  const paypal = deps.paypal ?? getPayPal();
  const value = toPayPalValue(reserved.amountMicro);

  let batchId: string | null = null;
  try {
    const created = await paypal.request<CreateBatchResponse>("POST", "/v1/payments/payouts", {
      requestId: reserved.id,
      body: {
        sender_batch_header: {
          sender_batch_id: reserved.id,
          email_subject: "You have a payout from Piko",
          email_message: "Your earnings from AI agents calling your API, via Piko.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value, currency: "USD" },
            receiver: reserved.email,
            sender_item_id: reserved.id,
            note: "Piko seller earnings",
          },
        ],
      },
    });
    batchId = created.batch_header?.payout_batch_id ?? null;
  } catch (error) {
    if (error instanceof PayPalError && error.status >= 400 && error.status < 500) {
      await reversePayout(db, reserved, sellerOrgId);
      throw new PayoutError("paypal_refused", `PayPal refused the payout: ${error.message}`);
    }
    // Unknown outcome: PayPal may have paid. Keep the debit; the webhook decides (P6-04).
    console.error(`Payout ${reserved.id} has an unknown outcome; left pending`, error);
    return {
      id: reserved.id,
      amountMicro: reserved.amountMicro,
      status: "pending",
      paypalBatchId: null,
    };
  }

  if (batchId) {
    await db.update(payouts).set({ paypalBatchId: batchId }).where(eq(payouts.id, reserved.id));
  }
  return {
    id: reserved.id,
    amountMicro: reserved.amountMicro,
    status: "pending",
    paypalBatchId: batchId,
  };
}

/**
 * Runs after a settle: pays the seller out once the balance reaches the threshold. Never
 * throws, so a payout problem can't fail the Call that triggered it. Returns the payout, or
 * null when none was due.
 */
export async function maybeAutoPayout(
  deps: PayoutDeps,
  sellerOrgId: string,
): Promise<Payout | null> {
  try {
    const threshold = deps.thresholdMicro ?? getEnv().PAYOUT_THRESHOLD_MICRO;
    // A cheap read first, so most settles never take the lock or touch PayPal.
    const [org] = await deps.db
      .select({ email: orgs.paypalEmail })
      .from(orgs)
      .where(eq(orgs.id, sellerOrgId));
    if (!org?.email) return null;
    if ((await balanceOf(deps.db, { type: "seller", orgId: sellerOrgId })) < threshold) return null;
    return await sendPayout({ ...deps, thresholdMicro: threshold }, sellerOrgId, "auto");
  } catch (error) {
    if (error instanceof PayoutError && error.code === "below_threshold") return null;
    console.error(`Automatic payout for seller ${sellerOrgId} failed`, error);
    return null;
  }
}

/** The seller's recent payouts, newest first, for the Seller console. */
export function listPayouts(db: Db, sellerOrgId: string, limit = 10) {
  return db
    .select({
      id: payouts.id,
      amountMicro: payouts.amountMicro,
      status: payouts.status,
      paypalBatchId: payouts.paypalBatchId,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .where(eq(payouts.sellerOrgId, sellerOrgId))
    .orderBy(sql`${payouts.createdAt} desc`, sql`${payouts.id} desc`)
    .limit(limit);
}
