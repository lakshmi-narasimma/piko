/**
 * Verifying and settling a payment: shared by the gateway and the facilitator endpoints.
 * Verifying only reads. Settling consumes the Receipt and writes the Call and its Ledger
 * entries in one transaction.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Db } from "../db/client";
import { calls } from "../db/schema";
import { LedgerError, settleCall } from "../ledger";
import { loadChallenge, type PayableChallenge } from "../pay";
import {
  buildRequirements,
  X402_VERSION,
  type PaymentRequirements,
  type SettlementResponse,
  type X402Config,
} from "../x402";
import { verifyReceipt, type ReceiptClaims } from "../x402/receipt";

export type PaymentFailureCode = "invalid_receipt" | "challenge_expired";

export interface PaymentFailure {
  code: PaymentFailureCode;
  message: string;
}

export type PaymentVerification =
  | { ok: true; claims: ReceiptClaims; challenge: PayableChallenge }
  | ({ ok: false } & PaymentFailure);

const invalid = (message: string): { ok: false } & PaymentFailure => ({
  ok: false,
  code: "invalid_receipt",
  message,
});
const expired = (message: string): { ok: false } & PaymentFailure => ({
  ok: false,
  code: "challenge_expired",
  message,
});

const paymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  accepted: z.unknown(),
  payload: z.object({ receipt: z.string().min(1) }),
});

export interface VerifyExpectations {
  /** The Endpoint being called through the gateway. */
  endpointId?: string;
  /** The requirements the resource server is enforcing, for the facilitator's verify. */
  requirements?: PaymentRequirements;
}

/**
 * Checks a PaymentPayload: signature, binding (Endpoint, amount, nonce), expiry and single
 * use. Read-only. The receipt's claims are compared with the Challenge row, and `accepted`
 * must be exactly what the 402 offered.
 */
export async function verifyPayment(
  { db, config }: { db: Db; config: X402Config },
  rawPayload: unknown,
  expect: VerifyExpectations = {},
): Promise<PaymentVerification> {
  const payload = paymentPayloadSchema.safeParse(rawPayload);
  if (!payload.success) return invalid("PAYMENT-SIGNATURE is not a valid PaymentPayload.");

  const verification = verifyReceipt(payload.data.payload.receipt, config.receiptSigningSecret);
  if (!verification.ok) {
    return verification.reason === "expired"
      ? expired("This Receipt has expired.")
      : invalid("This Receipt's signature is not valid.");
  }
  const { claims } = verification;

  const challenge = await loadChallenge(db, claims.nonce);
  if (!challenge) return invalid("This Receipt names an unknown Challenge.");

  const bound =
    claims.endpointId === challenge.endpointId &&
    claims.sellerId === challenge.sellerOrgId &&
    claims.amount === challenge.amountMicro.toString() &&
    claims.agentId === challenge.agentId &&
    claims.orgId === challenge.buyerOrgId;
  if (!bound) return invalid("This Receipt does not match its Challenge.");

  if (expect.endpointId !== undefined && expect.endpointId !== claims.endpointId) {
    return invalid("This Receipt is for a different endpoint.");
  }

  // Before comparing `accepted`: releasing a failed attempt also expires the Challenge,
  // which changes what it offers, and that Receipt should read as used, not invalid.
  if (challenge.consumedAt) return expired("This Receipt has already been used.");
  if (!challenge.reservationActive) return expired("This Receipt's reservation has ended.");

  const offered = buildRequirements(config, challenge);
  if (!isDeepStrictEqual(payload.data.accepted, offered)) {
    return invalid("PaymentPayload.accepted is not what the Challenge offered.");
  }
  if (expect.requirements !== undefined && !isDeepStrictEqual(expect.requirements, offered)) {
    return invalid("paymentRequirements is not what the Challenge offered.");
  }

  return { ok: true, claims, challenge };
}

export type SettlementResult =
  { ok: true; response: SettlementResponse } | ({ ok: false } & PaymentFailure);

/**
 * Settles a verified payment: consumes the Receipt, posts the Ledger entries and writes
 * the Call, atomically. A Receipt that lost a race or expired comes back as a failure.
 */
export async function settlePayment(
  db: Db,
  config: X402Config,
  claims: ReceiptClaims,
  outcome: { upstreamStatus?: number; latencyMs?: number } = {},
): Promise<SettlementResult> {
  const callId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      const settled = await settleCall(tx, { nonce: claims.nonce, callId });
      await tx.insert(calls).values({
        id: callId,
        nonce: claims.nonce,
        agentId: settled.agentId,
        buyerOrgId: settled.buyerOrgId,
        endpointId: settled.endpointId,
        amountMicro: settled.priceMicro,
        status: "paid",
        upstreamStatus: outcome.upstreamStatus,
        latencyMs: outcome.latencyMs,
      });
    });
  } catch (error) {
    if (
      error instanceof LedgerError &&
      ["challenge_not_found", "challenge_consumed", "reservation_not_active"].includes(error.code)
    ) {
      return expired("This Receipt has already been used or its reservation has ended.");
    }
    throw error;
  }

  return {
    ok: true,
    response: {
      success: true,
      transaction: callId,
      network: config.network,
      payer: claims.agentId,
      amount: claims.amount,
    },
  };
}
