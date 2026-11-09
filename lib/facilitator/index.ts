/**
 * The x402 v2 facilitator endpoints (docs/API.md section 3), for sellers not behind the
 * hosted gateway. They share the gateway's verify and settle code.
 */
import { z } from "zod";
import { settlePayment, verifyPayment } from "../gateway/settlement";
import { jsonError } from "../http";
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

const facilitatorRequestSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: z.unknown(),
  paymentRequirements: z.custom<PaymentRequirements>(
    (value) => typeof value === "object" && value !== null,
  ),
});

type FacilitatorRequest = z.infer<typeof facilitatorRequestSchema>;

async function readRequest(request: Request): Promise<FacilitatorRequest | null> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = facilitatorRequestSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

const invalidRequest = () =>
  jsonError(
    400,
    "invalid_request",
    "The body must be { x402Version: 2, paymentPayload, paymentRequirements }.",
  );

/** Handles `POST /api/facilitator/verify`. Read-only: it never consumes the Receipt. */
export async function handleVerifyRequest(
  deps: FacilitatorDeps,
  request: Request,
): Promise<Response> {
  const body = await readRequest(request);
  if (!body) return invalidRequest();

  const verified = await verifyPayment(deps, body.paymentPayload, {
    requirements: body.paymentRequirements,
  });
  return Response.json(
    verified.ok
      ? { isValid: true, payer: verified.claims.agentId }
      : { isValid: false, invalidReason: verified.code, invalidMessage: verified.message },
  );
}

/** Handles `POST /api/facilitator/settle`: consumes the Receipt and settles the Ledger. */
export async function handleSettleRequest(
  deps: FacilitatorDeps,
  request: Request,
): Promise<Response> {
  const { db, config } = deps;
  const body = await readRequest(request);
  if (!body) return invalidRequest();

  const verified = await verifyPayment(deps, body.paymentPayload, {
    requirements: body.paymentRequirements,
  });
  const settled = verified.ok ? await settlePayment(db, config, verified.claims) : verified;
  if (settled.ok) return Response.json(settled.response);

  if (settled.code === "challenge_expired") {
    return jsonError(410, settled.code, settled.message);
  }
  const failed: SettlementResponse = {
    success: false,
    errorReason: settled.code,
    errorMessage: settled.message,
    transaction: "",
    network: config.network,
  };
  return Response.json(failed);
}
