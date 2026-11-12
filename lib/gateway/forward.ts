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
// set-cookie is dropped because the gateway answers on the app's origin: a seller must never
// be able to set (or overwrite) a cookie there, such as the dashboard's session.
const RESPONSE_HEADERS_NOT_FORWARDED = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * Set on every proxied response. A seller's body is served from the app's origin, so a
 * browser must never run it as an active page there: no sniffing a JSON body into HTML,
 * and any HTML that is served gets a sandboxed, opaque origin with no scripts.
 */
export const PROXIED_RESPONSE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
};

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
  /**
   * The secret sent as X-Piko-Secret. `listings` has no column for a seller's own secret
   * yet, so this is DEMO_UPSTREAM_SECRET for the sample seller APIs and null otherwise
   * (see upstreamSecretFor).
   */
  upstreamSecret?: string | null;
}

/** Where the sample seller APIs live under the app (docs/SEED_DATA.md §3). */
export const DEMO_SELLERS_PATH = "/api/demo/sellers";

/** The full upstream URL for a request: only the stored route chooses it. */
export function upstreamUrl(route: Pick<GatewayRoute, "baseUrl" | "path">, request: Request) {
  return `${route.baseUrl.replace(/\/+$/, "")}${route.path}${new URL(request.url).search}`;
}

/**
 * The secret to send a route's upstream. Only the app's own sample seller APIs, under
 * `${appBaseUrl}/api/demo/sellers/`, get DEMO_UPSTREAM_SECRET: sending it anywhere else
 * would hand it to a third-party seller. Sellers have no stored secret yet, so any other
 * upstream gets none.
 */
export function upstreamSecretFor(
  url: string,
  config: { appBaseUrl: string; demoUpstreamSecret?: string },
): string | null {
  if (!config.demoUpstreamSecret) return null;
  let target: URL;
  let app: URL;
  try {
    target = new URL(url);
    app = new URL(config.appBaseUrl);
  } catch {
    return null;
  }
  // URL parsing has already resolved any "." or ".." segments in the path.
  const prefix = `${app.pathname.replace(/\/+$/, "")}${DEMO_SELLERS_PATH}/`;
  if (target.origin !== app.origin || !target.pathname.startsWith(prefix)) return null;
  return config.demoUpstreamSecret;
}

export type ForwardableBody = { ok: true; body: ArrayBuffer | null } | { ok: false };

/**
 * Reads the request body to forward (null for methods that have none), giving up after
 * `timeoutMs` so a slow upload can't keep a request open past its payment hold.
 */
export async function readForwardableBody(
  request: Request,
  timeoutMs: number,
): Promise<ForwardableBody> {
  if (request.method === "GET" || request.method === "HEAD") return { ok: true, body: null };
  if (!request.body) return { ok: true, body: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "timeout") {
        void reader.cancel().catch(() => {});
        return { ok: false };
      }
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: body.buffer };
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
  const url = upstreamUrl(route, request);

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
