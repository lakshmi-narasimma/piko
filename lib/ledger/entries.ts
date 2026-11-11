import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { ledgerEntries } from "../db/schema";
import { getEnv } from "../env";
import { isDuplicateEvent, LedgerError } from "./errors";
import { splitPrice } from "./fee";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database client or an open transaction, so callers can compose these functions. */
export type DbOrTx = Db | Tx;

export type LedgerAccount = { type: "wallet" | "seller"; orgId: string } | { type: "platform" };

export interface PostCallInput {
  callId: string;
  buyerOrgId: string;
  sellerOrgId: string;
  priceMicro: bigint;
}

export interface PostedCall extends PostCallInput {
  txnId: string;
  sellerMicro: bigint;
  platformMicro: bigint;
}

export interface RefundedCall {
  callId: string;
  txnId: string;
  /** What went back into the buyer's wallet. */
  refundedMicro: bigint;
}

/** An account's balance: the sum of its Ledger entries. */
export async function balanceOf(db: DbOrTx, account: LedgerAccount): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.accountType, account.type),
        account.type === "platform"
          ? isNull(ledgerEntries.orgId)
          : eq(ledgerEntries.orgId, account.orgId),
      ),
    );
  return BigInt(row!.total);
}

/**
 * Writes a Call's three Ledger entries in one transaction. This does not check funds:
 * paid Calls go through reserveFunds and settleCall. Use this directly only for Calls
 * with no Challenge, such as seeded traffic.
 *
 * @throws LedgerError `invalid_amount` or `call_already_posted`.
 */
export async function postCall(db: DbOrTx, input: PostCallInput): Promise<PostedCall> {
  const { callId, buyerOrgId, sellerOrgId, priceMicro } = input;
  if (priceMicro <= 0n) {
    throw new LedgerError("invalid_amount", "A posted Call must have a positive price.");
  }

  const { sellerMicro, platformMicro } = splitPrice(priceMicro, BigInt(getEnv().PLATFORM_FEE_BPS));
  const txnId = randomUUID();
  const common = { txnId, reason: "call", refId: callId } as const;

  try {
    // Nested, this is a savepoint: a duplicate leaves the caller's transaction usable.
    await db.transaction((tx) =>
      tx.insert(ledgerEntries).values([
        { ...common, accountType: "wallet", orgId: buyerOrgId, amountMicro: -priceMicro },
        { ...common, accountType: "seller", orgId: sellerOrgId, amountMicro: sellerMicro },
        { ...common, accountType: "platform", orgId: null, amountMicro: platformMicro },
      ]),
    );
  } catch (error) {
    if (isDuplicateEvent(error)) {
      throw new LedgerError("call_already_posted", `Call ${callId} is already posted.`);
    }
    throw error;
  }

  return { ...input, txnId, sellerMicro, platformMicro };
}

/**
 * Reverses a posted Call with three entries. It negates what was posted rather than
 * recomputing it, so a later change to PLATFORM_FEE_BPS can't unbalance a refund.
 *
 * @throws LedgerError `call_not_posted` or `call_already_refunded`.
 */
export async function refundCall(db: DbOrTx, callId: string): Promise<RefundedCall> {
  const txnId = randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const posted = await tx
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.reason, "call"), eq(ledgerEntries.refId, callId)));
      if (posted.length === 0) {
        throw new LedgerError("call_not_posted", `Call ${callId} was never posted.`);
      }

      await tx.insert(ledgerEntries).values(
        posted.map((entry) => ({
          txnId,
          accountType: entry.accountType,
          orgId: entry.orgId,
          amountMicro: -entry.amountMicro,
          reason: "refund" as const,
          refId: callId,
        })),
      );

      const buyer = posted.find((entry) => entry.accountType === "wallet")!;
      return { callId, txnId, refundedMicro: -buyer.amountMicro };
    });
  } catch (error) {
    if (isDuplicateEvent(error)) {
      throw new LedgerError("call_already_refunded", `Call ${callId} is already refunded.`);
    }
    throw error;
  }
}
