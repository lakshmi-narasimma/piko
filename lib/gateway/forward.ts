import { withUpstreamSecret } from "../keys";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "../x402";
import type { GatewayRoute } from "./route";

export const AUTOPAY_HEADER = "X-Piko-Autopay";

/** The largest request body the gateway forwards, unless GATEWAY_MAX_BODY_BYTES says otherwise. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** The largest upstream response the gateway reads, unless GATEWAY_MAX_RESPONSE_BYTES says otherwise. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Hop-by-hop headers (RFC 9110 section 7.6.1) describe one connection, so they are never
// passed on in either direction. Any header the Connection header names is hop-by-hop too,
// and so is every Proxy-* header (see stripHeaders). content-length is dropped because fetch
// recomputes it for the body it sends, and has already decoded the body it received.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Never sent upstream, on top of the hop-by-hop headers and every X-Piko-* header: the agent's
// Key and cookies, and its Receipt. X-Piko-Secret is added back afterwards, for the sample
// seller APIs only (withUpstreamSecret). Idempotency-Key is the agent's own header and is
// forwarded like any other (docs/API.md section 2).
const REQUEST_HEADERS_NOT_FORWARDED = ["authorization", "cookie", PAYMENT_SIGNATURE_HEADER];

// Never passed back to the agent, on top of the hop-by-hop headers and every X-Piko-* header.
// fetch has already decoded the body, so content-encoding no longer describes it. set-cookie
// is dropped because the gateway answers on the app's origin: a seller must never be able to
// set (or overwrite) a cookie there, such as the dashboard's session. The x402 headers are
// the gateway's alone, so a seller can't make a free Call look paid.
const RESPONSE_HEADERS_NOT_FORWARDED = [
  "content-encoding",
  "set-cookie",
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
];

/**
 * A copy of `source` without the hop-by-hop headers (including any the Connection header
 * names and every Proxy-* header), without Piko's own X-Piko-* headers, and without the
 * names in `drop`, which match in any case.
 */
export function stripHeaders(source: Headers, drop: readonly string[]): Headers {
  const named = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const dropped = new Set([...HOP_BY_HOP_HEADERS, ...drop.map((name) => name.toLowerCase())]);
  const headers = new Headers();
  // Headers iterates with lower-case names.
  source.forEach((value, name) => {
    if (dropped.has(name) || named.has(name)) return;
    if (name.startsWith("proxy-") || name.startsWith("x-piko-")) return;
    headers.append(name, value);
  });
  return headers;
}

/** The agent's request headers as the seller's upstream gets them, before X-Piko-Secret. */
export function upstreamRequestHeaders(request: Headers): Headers {
  return stripHeaders(request, REQUEST_HEADERS_NOT_FORWARDED);
}

/** The upstream's response headers as the agent gets them, before URLs are rewritten. */
export function agentResponseHeaders(upstream: Headers): Headers {
  return stripHeaders(upstream, RESPONSE_HEADERS_NOT_FORWARDED);
}

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

/**
 * Why an upstream call counts as failed. `unreachable` covers a DNS failure, a refused
 * connection, a TLS error and a URL the SSRF re-check refused.
 */
export type UpstreamFailureReason =
  "unreachable" | "timeout" | "server_error" | "response_too_large";

export type UpstreamFailure = {
  ok: false;
  reason: UpstreamFailureReason;
  /** The upstream's HTTP status, when it answered at all. */
  status: number | null;
  latencyMs: number;
};

export type UpstreamResult =
  | { ok: true; status: number; headers: Headers; body: ArrayBuffer; latencyMs: number }
  | UpstreamFailure;

/** The message of a `502 upstream_failed`. It never reveals the upstream's URL. */
export function upstreamFailureMessage(failure: UpstreamFailure): string {
  switch (failure.reason) {
    case "unreachable":
      return "The seller's API is unreachable: the gateway could not connect to it. Nothing was charged.";
    case "timeout":
      return "The seller's API did not answer in time. Nothing was charged.";
    case "server_error":
      return `The seller's API failed with HTTP ${failure.status}. Nothing was charged.`;
    case "response_too_large":
      return "The seller's API sent a response larger than the gateway allows. Nothing was charged.";
  }
}

export interface ForwardOptions {
  /** How long the whole upstream call may take, body included. */
  timeoutMs: number;
  /** The largest response body to read. Defaults to DEFAULT_MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  /**
   * The secret sent as X-Piko-Secret. `listings` has no column for a seller's own secret
   * yet, so this is DEMO_UPSTREAM_SECRET for the sample seller APIs and null otherwise
   * (see upstreamSecretFor).
   */
  upstreamSecret?: string | null;
}

/** Where the sample seller APIs live under the app (docs/SEED_DATA.md §3). */
export const DEMO_SELLERS_PATH = "/api/demo/sellers";

/**
 * The full upstream URL for a request: only the stored route chooses it. The agent's query
 * string is appended exactly as sent, so repeated keys and their order survive.
 */
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

type CappedRead =
  { ok: true; bytes: ArrayBuffer } | { ok: false; reason: "timeout" | "too_large" | "error" };

/**
 * Reads a whole stream, giving up as soon as it passes `maxBytes` or, with `timeoutMs`,
 * when that time runs out. The size is counted as the bytes arrive, so a missing or false
 * Content-Length can't get past it. A stream given up on is cancelled.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  timeoutMs?: number,
): Promise<CappedRead> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    timeoutMs === undefined
      ? null
      : new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read());
      if (next === "timeout") {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "timeout" };
      }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: bytes.buffer };
}

/** A Content-Length that is a whole number above `maxBytes`. Anything else is left to the stream. */
function declaresMoreThan(headers: Headers, maxBytes: number): boolean {
  const value = headers.get("content-length");
  return value !== null && /^\d+$/.test(value.trim()) && Number(value) > maxBytes;
}

export type ForwardableBody =
  { ok: true; body: ArrayBuffer | null } | { ok: false; reason: "timeout" | "too_large" };

/**
 * Reads the request body to forward (null for methods that have none). It gives up after
 * `timeoutMs`, so a slow upload can't keep a request open past its payment hold, and as
 * soon as the body passes `maxBytes`, whatever its Content-Length said.
 */
export async function readForwardableBody(
  request: Request,
  timeoutMs: number,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<ForwardableBody> {
  if (request.method === "GET" || request.method === "HEAD") return { ok: true, body: null };
  if (!request.body) return { ok: true, body: new ArrayBuffer(0) };
  if (declaresMoreThan(request.headers, maxBytes)) {
    void request.body.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }

  const read = await readCapped(request.body, maxBytes, timeoutMs);
  if (read.ok) return { ok: true, body: read.bytes };
  // A body that broke off mid-upload never fully arrived, like one that timed out.
  return { ok: false, reason: read.reason === "too_large" ? "too_large" : "timeout" };
}

/**
 * Forwards a request to the seller's upstream with its method, query string and body, and
 * with the headers upstreamRequestHeaders keeps. Only the stored route chooses the URL. A
 * 5xx, a timeout, an unreachable upstream or a response over `maxResponseBytes` comes back
 * as `ok: false`.
 */
export async function forwardUpstream(
  route: GatewayRoute,
  request: Request,
  body: ArrayBuffer | null,
  options: ForwardOptions,
): Promise<UpstreamResult> {
  const url = upstreamUrl(route, request);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs);
  const started = Date.now();
  const failed = (reason: UpstreamFailureReason, status: number | null = null): UpstreamFailure => {
    console.warn(`Gateway upstream of seller '${route.sellerSlug}' failed (${reason})`);
    return { ok: false, reason, status, latencyMs: Date.now() - started };
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers: withUpstreamSecret(upstreamRequestHeaders(request.headers), options.upstreamSecret),
      body,
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch {
    return failed(signal.aborted ? "timeout" : "unreachable");
  }

  if (upstream.status >= 500) {
    void upstream.body?.cancel().catch(() => {});
    return failed("server_error", upstream.status);
  }
  if (declaresMoreThan(upstream.headers, maxResponseBytes)) {
    void upstream.body?.cancel().catch(() => {});
    return failed("response_too_large", upstream.status);
  }
  let responseBody = new ArrayBuffer(0);
  if (upstream.body) {
    const read = await readCapped(upstream.body, maxResponseBytes);
    if (!read.ok) {
      if (read.reason === "too_large") return failed("response_too_large", upstream.status);
      return failed(signal.aborted ? "timeout" : "unreachable", upstream.status);
    }
    responseBody = read.bytes;
  }
  const latencyMs = Date.now() - started;

  const responseHeaders = agentResponseHeaders(upstream.headers);
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
}
