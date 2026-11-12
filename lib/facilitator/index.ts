/**
 * The x402 v2 facilitator endpoints (docs/API.md section 3), for sellers not behind the
 * hosted gateway. They share the gateway's verify and settle code.
 */
import { settlePayment, verifyPayment } from "../gateway/settlement";
import type { Db } from "../db/client";
import { orInternalError } from "../http";
import { currentFrozenScope } from "../keys";
import { releaseReservation } from "../ledger";
import {
  PAYPAL_LEDGER_SCHEME,
  X402_VERSION,
  type PaymentRequirements,
  type SettlementResponse,
  type X402Config,
} from "../x402";

export interface FacilitatorDeps {
  db: Db;
  config: X402Config;
}

export function supportedResponse(config: X402Config) {
  return {
    kinds: [{ x402Version: X402_VERSION, scheme: PAYPAL_LEDGER_SCHEME, network: config.network }],
    extensions: [],
    signers: {},
  };
}

/** x402's error codes for a request body the facilitator can't use. */
export type FacilitatorRequestError =
  "invalid_payload" | "invalid_x402_version" | "invalid_payment_requirements";

interface FacilitatorRequest {
  paymentPayload: unknown;
  paymentRequirements: PaymentRequirements;
}

type ReadResult =
  | { ok: true; body: FacilitatorRequest }
  | { ok: false; code: FacilitatorRequestError; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readRequest(request: Request): Promise<ReadResult> {
  const body: unknown = await request.json().catch(() => null);
  if (!isObject(body)) {
    return {
      ok: false,
      code: "invalid_payload",
      message: "The body must be { x402Version: 2, paymentPayload, paymentRequirements }.",
    };
  }
  if (body.x402Version !== X402_VERSION) {
    return { ok: false, code: "invalid_x402_version", message: "x402Version must be 2." };
  }
  if (body.paymentPayload === undefined) {
    return { ok: false, code: "invalid_payload", message: "paymentPayload is required." };
  }
  if (!isObject(body.paymentRequirements)) {
    return {
      ok: false,
      code: "invalid_payment_requirements",
      message: "paymentRequirements must be an object.",
    };
  }
  return {
    ok: true,
    body: {
      paymentPayload: body.paymentPayload,
      // verifyPayment compares it field by field with what the Challenge offered.
      paymentRequirements: body.paymentRequirements as unknown as PaymentRequirements,
    },
  };
}

/** A failed settle, as x402's SettleResponse, so an x402 SDK can parse every answer. */
function settleFailure(
  config: X402Config,
  status: number,
  errorReason: string,
  errorMessage: string,
): Response {
  const failed: SettlementResponse = {
    success: false,
    errorReason,
    errorMessage,
    transaction: "",
    network: config.network,
  };
  return Response.json(failed, { status });
}

/**
 * Handles `POST /api/facilitator/verify`. Read-only: it never consumes the Receipt.
 * An unexpected failure is logged and answered `500 internal_error`.
 */
export function handleVerifyRequest(deps: FacilitatorDeps, request: Request): Promise<Response> {
  return orInternalError("POST /api/facilitator/verify", () => verifyRequest(deps, request));
}

async function verifyRequest(deps: FacilitatorDeps, request: Request): Promise<Response> {
  const read = await readRequest(request);
  if (!read.ok) {
    return Response.json(
      { isValid: false, invalidReason: read.code, invalidMessage: read.message },
      { status: 400 },
    );
  }

  const verified = await verifyPayment(deps, read.body.paymentPayload, {
    requirements: read.body.paymentRequirements,
  });
  if (!verified.ok) {
    return Response.json({
      isValid: false,
      invalidReason: verified.code,
      invalidMessage: verified.message,
    });
  }
  // Read-only, like the rest of verify: the hold stays until settle or its expiry.
  const frozen = await currentFrozenScope(deps.db, verified.claims.agentId);
  if (frozen) {
    return Response.json({
      isValid: false,
      invalidReason: "agent_frozen",
      invalidMessage: frozenMessage(frozen),
    });
  }
  return Response.json({ isValid: true, payer: verified.claims.agentId });
}

const frozenMessage = (scope: string) => `This agent is frozen at ${scope} level.`;

/**
 * Handles `POST /api/facilitator/settle`: consumes the Receipt and settles the Ledger.
 * Open to anyone holding the PaymentPayload, because the Receipt is the credential
 * (docs/API.md section 3). Every answer, failures included, is a SettlementResponse, except
 * an unexpected failure: that is logged and answered `500 internal_error`.
 */
export function handleSettleRequest(deps: FacilitatorDeps, request: Request): Promise<Response> {
  return orInternalError("POST /api/facilitator/settle", () => settleRequest(deps, request));
}

async function settleRequest(deps: FacilitatorDeps, request: Request): Promise<Response> {
  const { db, config } = deps;
  const read = await readRequest(request);
  if (!read.ok) return settleFailure(config, 400, read.code, read.message);

  const verified = await verifyPayment(deps, read.body.paymentPayload, {
    requirements: read.body.paymentRequirements,
  });
  if (verified.ok) {
    // The kill switch: a Receipt issued before a freeze or a breaker trip can't be settled
    // after it. Nothing is charged and the hold is released.
    const frozen = await currentFrozenScope(db, verified.claims.agentId);
    if (frozen) {
      await releaseReservation(db, verified.claims.nonce);
      return settleFailure(config, 423, "agent_frozen", frozenMessage(frozen));
    }
  }
  const settled = verified.ok ? await settlePayment(db, config, verified.claims) : verified;
  if (settled.ok) return Response.json(settled.response);

  const status = settled.code === "challenge_expired" ? 410 : 200;
  return settleFailure(config, status, settled.code, settled.message);
}
