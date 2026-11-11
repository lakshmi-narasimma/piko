import { withUpstreamSecret } from "../keys";
import { PAYMENT_SIGNATURE_HEADER } from "../x402";
import type { GatewayRoute } from "./route";

export const AUTOPAY_HEADER = "X-Piko-Autopay";

// Never sent upstream: hop-by-hop headers, the agent's credentials and Piko's own headers.
// content-length is dropped because fetch recomputes it for the forwarded body.
const REQUEST_HEADERS_NOT_FORWARDED = [
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  PAYMENT_SIGNATURE_HEADER,
  AUTOPAY_HEADER,
];

// fetch has already decoded the body, so the original framing headers no longer describe it.
const RESPONSE_HEADERS_NOT_FORWARDED = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Headers whose value is a URL. One that points at the upstream would reveal the seller's
// base URL, so it is rewritten onto the gateway (see rewriteUpstreamUrl).
const URL_RESPONSE_HEADERS = ["location", "content-location"];

/**
 * Maps a URL from an upstream response header onto the gateway. A URL under the seller's
 * base URL becomes the matching root-relative `/g/{seller}/...` path. Any other URL on the
 * upstream's origin is dropped (null), since it would reveal the upstream. A URL on another
 * origin is the seller's own choice to share, so it passes through unchanged.
 */
export function rewriteUpstreamUrl(
  value: string,
  route: Pick<GatewayRoute, "baseUrl" | "sellerSlug">,
  upstreamUrl: string,
): string | null {
  let target: URL;
  try {
    target = new URL(value, upstreamUrl);
  } catch {
    return null;
  }
  const base = new URL(route.baseUrl);
  if (target.origin !== base.origin) return value;

  const basePath = base.pathname.replace(/\/+$/, "");
  const path = target.pathname;
  if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
  const rest = path.slice(basePath.length) || "/";
  return `/g/${route.sellerSlug}${rest}${target.search}${target.hash}`;
}

export type UpstreamResult =
  | { ok: true; status: number; headers: Headers; body: ArrayBuffer; latencyMs: number }
  | { ok: false; status: number | null; latencyMs: number };

export interface ForwardOptions {
  /** How long the whole upstream call may take, body included. */
  timeoutMs: number;
  /** The seller's shared secret. `listings` has no column for it yet, so this is null. */
  upstreamSecret?: string | null;
}

/** The request body to forward, or null for methods that have none. */
export async function readForwardableBody(request: Request): Promise<ArrayBuffer | null> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  return request.arrayBuffer();
}

/**
 * Forwards a request to the seller's upstream. Only the stored route chooses the URL; the
 * caller supplies just the query string. A 5xx or timeout comes back as `ok: false`.
 */
export async function forwardUpstream(
  route: GatewayRoute,
  request: Request,
  body: ArrayBuffer | null,
  options: ForwardOptions,
): Promise<UpstreamResult> {
  const url = `${route.baseUrl.replace(/\/+$/, "")}${route.path}${new URL(request.url).search}`;

  const headers = new Headers(request.headers);
  for (const name of REQUEST_HEADERS_NOT_FORWARDED) headers.delete(name);

  const started = Date.now();
  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers: withUpstreamSecret(headers, options.upstreamSecret),
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const responseBody = await upstream.arrayBuffer();
    const latencyMs = Date.now() - started;
    if (upstream.status >= 500) return { ok: false, status: upstream.status, latencyMs };

    const responseHeaders = new Headers(upstream.headers);
    for (const name of RESPONSE_HEADERS_NOT_FORWARDED) responseHeaders.delete(name);
    for (const name of URL_RESPONSE_HEADERS) {
      const value = responseHeaders.get(name);
      if (value === null) continue;
      const rewritten = rewriteUpstreamUrl(value, route, url);
      if (rewritten === null) responseHeaders.delete(name);
      else responseHeaders.set(name, rewritten);
    }
    return {
      ok: true,
      status: upstream.status,
      headers: responseHeaders,
      body: responseBody,
      latencyMs,
    };
  } catch {
    return { ok: false, status: null, latencyMs: Date.now() - started };
  }
}
