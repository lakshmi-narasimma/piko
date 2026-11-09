/**
 * The hosted gateway behind `/g/{seller}/{path}`: finds the Endpoint, applies the free
 * allowance and answers with a 402 Challenge (docs/API.md section 2).
 *
 * The route file passes in the database and config, so tests can drive this directly.
 */
import type { Db } from "../db/client";
import { getEnv } from "../env";
import { jsonError } from "../http";
import { authenticateRequest, type AuthenticatedAgent } from "../keys";
import { releaseReservation } from "../ledger";
import { payErrorResponse, runPayPipeline, type IssuedReceipt } from "../pay";
import {
  decodeHeaderValue,
  encodeHeaderValue,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  x402ConfigFromEnv,
  type SettlementResponse,
  type X402Config,
} from "../x402";
import type { ReceiptClaims } from "../x402/receipt";
import { issueChallenge } from "./challenge";
import {
  AUTOPAY_HEADER,
  forwardUpstream,
  readForwardableBody,
  type UpstreamResult,
} from "./forward";
import { claimFreeCall, completeFreeCall, releaseFreeCall } from "./free";
import { findRoute, type GatewayRoute } from "./route";
import {
  settlePayment,
  verifyPayment,
  type PaymentFailure,
  type PaymentFailureCode,
} from "./settlement";

export interface GatewayConfig extends X402Config {
  upstreamTimeoutMs: number;
}

export interface GatewayDeps {
  db: Db;
  config: GatewayConfig;
}

export function gatewayConfigFromEnv(): GatewayConfig {
  return { ...x402ConfigFromEnv(), upstreamTimeoutMs: getEnv().UPSTREAM_TIMEOUT_MS };
}

/** What a browser caller may read and send. Answered on every gateway response. */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": [
    PAYMENT_SIGNATURE_HEADER,
    "Content-Type",
    "Authorization",
    AUTOPAY_HEADER,
  ].join(", "),
  "Access-Control-Expose-Headers": [PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER].join(", "),
};

function withCors(response: Response): Response {
  // A Response from fetch has immutable headers, so always build a new one.
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function agentFrozen(agent: AuthenticatedAgent): Response {
  return jsonError(423, "agent_frozen", `This agent is frozen at ${agent.frozenScope} level.`, {
    scope: agent.frozenScope,
  });
}

function upstreamResponse(result: Extract<UpstreamResult, { ok: true }>): Response {
  // A Response with one of these statuses must not have a body at all, even an empty one.
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers: result.headers });
}

/**
 * Runs a free Call: forwards upstream and records it. An upstream failure gives the free
 * Call back and charges nothing.
 */
async function serveFreeCall(
  { db, config }: GatewayDeps,
  route: GatewayRoute,
  request: Request,
  callId: string,
): Promise<Response> {
  const body = await readForwardableBody(request);
  const result = await forwardUpstream(route, request, body, {
    timeoutMs: config.upstreamTimeoutMs,
    upstreamSecret: null,
  });
  if (!result.ok) {
    await releaseFreeCall(db, callId);
    return jsonError(502, "upstream_failed", "The upstream API failed. Nothing was charged.", {
      refunded: false,
    });
  }
  await completeFreeCall(db, callId, {
    upstreamStatus: result.status,
    latencyMs: result.latencyMs,
  });
  return upstreamResponse(result);
}

const PAYMENT_STATUS: Record<PaymentFailureCode, number> = {
  invalid_receipt: 402,
  challenge_expired: 410,
};

function paymentRejected(failure: PaymentFailure): Response {
  return jsonError(PAYMENT_STATUS[failure.code], failure.code, failure.message);
}

// Receipts being served by this process. A second request with the same Receipt is turned
// away before it reaches the seller, so one Receipt can't cause two upstream calls. Across
// processes the settle transaction still charges only once.
const receiptsInFlight = new Set<string>();

function withPaymentResponse(response: Response, settlement: SettlementResponse): Response {
  const headers = new Headers(response.headers);
  headers.set(PAYMENT_RESPONSE_HEADER, encodeHeaderValue(settlement));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Forwards a verified payment upstream, then settles: x402's authorization flow.
 * Below a 500 the Call is paid. On a 5xx or timeout nothing is settled and the hold ends.
 */
async function servePaidCall(
  { db, config }: GatewayDeps,
  route: GatewayRoute,
  request: Request,
  claims: ReceiptClaims,
): Promise<Response> {
  if (receiptsInFlight.has(claims.nonce)) {
    return paymentRejected({ code: "challenge_expired", message: "This Receipt is in use." });
  }
  receiptsInFlight.add(claims.nonce);
  try {
    const body = await readForwardableBody(request);
    const result = await forwardUpstream(route, request, body, {
      timeoutMs: config.upstreamTimeoutMs,
      upstreamSecret: null,
    });
    if (!result.ok) {
      await releaseReservation(db, claims.nonce);
      return withPaymentResponse(
        jsonError(502, "upstream_failed", "The upstream API failed. Nothing was charged.", {
          refunded: true,
        }),
        {
          success: false,
          errorReason: "upstream_failed",
          transaction: "",
          network: config.network,
        },
      );
    }
    const settlement = await settlePayment(db, config, claims, {
      upstreamStatus: result.status,
      latencyMs: result.latencyMs,
    });
    if (!settlement.ok) return paymentRejected(settlement);
    return withPaymentResponse(upstreamResponse(result), settlement.response);
  } finally {
    receiptsInFlight.delete(claims.nonce);
  }
}

/**
 * Runs the whole x402 loop inside one request: Challenge, then the pay pipeline, then the
 * same verify, forward and settle path a client's own retry takes. It charges once.
 */
async function serveAutopay(
  deps: GatewayDeps,
  route: GatewayRoute,
  request: Request,
  buyer: AuthenticatedAgent,
): Promise<Response> {
  const { nonce } = await issueChallenge(deps.db, deps.config, route, buyer);

  let issued: IssuedReceipt;
  try {
    issued = await runPayPipeline(deps, request.headers, { nonce });
  } catch (error) {
    return payErrorResponse(error);
  }

  const verified = await verifyPayment(deps, decodeHeaderValue(issued.paymentSignature), {
    endpointId: route.endpointId,
  });
  if (!verified.ok) return paymentRejected(verified);
  return servePaidCall(deps, route, request, verified.claims);
}

async function handle(
  deps: GatewayDeps,
  request: Request,
  params: { seller: string; path: string[] },
): Promise<Response> {
  const { db, config } = deps;
  const path = `/${params.path.join("/")}`;

  const route = await findRoute(db, params.seller, request.method, path);
  if (!route) {
    return jsonError(
      404,
      "not_found",
      `No endpoint matches ${request.method} ${path} on seller '${params.seller}'.`,
    );
  }

  const paymentSignature = request.headers.get(PAYMENT_SIGNATURE_HEADER);
  if (paymentSignature !== null) {
    const verified = await verifyPayment(deps, decodeHeaderValue(paymentSignature), {
      endpointId: route.endpointId,
    });
    if (!verified.ok) return paymentRejected(verified);
    return servePaidCall(deps, route, request, verified.claims);
  }

  let buyer: AuthenticatedAgent | null = null;
  if (request.headers.has("authorization")) {
    const auth = await authenticateRequest(db, request.headers);
    if (!auth.ok) return jsonError(401, "invalid_key", "Missing, wrong or revoked key.");
    buyer = auth;
    if (buyer.frozenScope) return agentFrozen(buyer);
  }

  if (buyer && route.freeQuota > 0) {
    const callId = await claimFreeCall(db, route, buyer);
    if (callId) return serveFreeCall(deps, route, request, callId);
  }

  if (request.headers.get(AUTOPAY_HEADER)?.toLowerCase() === "true") {
    if (!buyer) return jsonError(401, "invalid_key", "X-Piko-Autopay needs an agent Key.");
    return serveAutopay(deps, route, request, buyer);
  }

  const { paymentRequired } = await issueChallenge(db, config, route, buyer);
  return Response.json(paymentRequired, {
    status: 402,
    headers: { [PAYMENT_REQUIRED_HEADER]: encodeHeaderValue(paymentRequired) },
  });
}

/** Handles any method on `/g/{seller}/{path}`. Every response carries the CORS headers. */
export async function handleGatewayRequest(
  deps: GatewayDeps,
  request: Request,
  params: { seller: string; path: string[] },
): Promise<Response> {
  // A preflight is answered before anything else, so it can never be asked to pay.
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  return withCors(await handle(deps, request, params));
}
