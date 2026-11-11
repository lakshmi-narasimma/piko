import { createHmac, timingSafeEqual } from "node:crypto";

/** What the signed session cookie carries. Everything else is loaded fresh from the database. */
export interface SessionClaims {
  accountId: string;
  orgId: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export const SESSION_COOKIE = "piko_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function mac(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/** `<base64url claims>.<base64url HMAC-SHA256>`. */
export function signSession(
  claims: Omit<SessionClaims, "exp">,
  secret: string,
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS }),
  ).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/** The claims if the token is genuine and unexpired, otherwise null. Never throws. */
export function readSession(
  token: string | undefined,
  secret: string,
  now?: number,
): SessionClaims | null {
  // No token means no clock read: Next's prerender rejects Date.now() before a request exists.
  if (!token) return null;
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return null;

  const given = Buffer.from(signature, "base64url");
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionClaims;
    const valid =
      typeof claims.accountId === "string" &&
      typeof claims.orgId === "string" &&
      typeof claims.exp === "number" &&
      claims.exp > Math.floor((now ?? Date.now()) / 1000);
    return valid ? claims : null;
  } catch {
    return null;
  }
}
