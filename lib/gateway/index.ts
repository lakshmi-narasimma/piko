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
import {
  encodeHeaderValue,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  x402ConfigFromEnv,
  type X402Config,
} from "../x402";
import { issueChallenge } from "./challenge";
import {
  AUTOPAY_HEADER,
  forwardUpstream,
  readForwardableBody,
  type UpstreamResult,
} from "./forward";
import { claimFreeCall, completeFreeCall, releaseFreeCall } from "./free";
import { findRoute, type GatewayRoute } from "./route";

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
