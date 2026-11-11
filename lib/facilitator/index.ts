/**
 * The x402 v2 facilitator endpoints (docs/API.md section 3), for sellers not behind the
 * hosted gateway. They share the gateway's verify and settle code.
 */
import { settlePayment, verifyPayment } from "../gateway/settlement";
import type { Db } from "../db/client";
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

/** Handles `POST /api/facilitator/verify`. Read-only: it never consumes the Receipt. */
export async function handleVerifyRequest(
  deps: FacilitatorDeps,
  request: Request,
): Promise<Response> {
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
  return Response.json(
    verified.ok
      ? { isValid: true, payer: verified.claims.agentId }
      : { isValid: false, invalidReason: verified.code, invalidMessage: verified.message },
  );
}

/**
 * Handles `POST /api/facilitator/settle`: consumes the Receipt and settles the Ledger.
 * Open to anyone holding the PaymentPayload, because the Receipt is the credential
 * (docs/API.md section 3). Every answer, failures included, is a SettlementResponse.
 */
export async function handleSettleRequest(
  deps: FacilitatorDeps,
  request: Request,
): Promise<Response> {
  const { db, config } = deps;
  const read = await readRequest(request);
  if (!read.ok) return settleFailure(config, 400, read.code, read.message);

  const verified = await verifyPayment(deps, read.body.paymentPayload, {
    requirements: read.body.paymentRequirements,
  });
  const settled = verified.ok ? await settlePayment(db, config, verified.claims) : verified;
  if (settled.ok) return Response.json(settled.response);

  const status = settled.code === "challenge_expired" ? 410 : 200;
  return settleFailure(config, status, settled.code, settled.message);
}
