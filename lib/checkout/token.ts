/**
 * Checkout tokens: the server's record of what the playground agent recommended.
 *
 * When a run ends with a recommendation, the run route signs the product (name, price in
 * micro-USD, link) and the buyer's org into a short-lived token and sends it with the `done`
 * event. The browser sends only that token to the checkout route, which verifies it and
 * charges the signed price. The browser never chooses an amount, and no table is needed.
 *
 * Format: `<base64url claims>.<base64url HMAC-SHA256>`. The key is derived from
 * SESSION_SECRET with a fixed label, so a checkout token can never pass as a session cookie
 * (or the other way round) even though both use the same shape.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MicroUsd } from "../money";

/** Long enough to read the answer and click Pay; short enough that a stale price expires. */
export const CHECKOUT_TOKEN_TTL_SECONDS = 30 * 60;

const KEY_LABEL = "piko/checkout-token/v1";

const claimsSchema = z.object({
  v: z.literal(1),
  /** One token, one PayPal order: this is the order's request id (see createCheckout). */
  jti: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1).max(200),
  priceMicro: z.string().regex(/^\d+$/),
  url: z.string().optional(),
  exp: z.number().int(),
});

export interface CheckoutClaims {
  jti: string;
  orgId: string;
  name: string;
  priceMicro: MicroUsd;
  url?: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export type CheckoutTokenVerification =
  { ok: true; claims: CheckoutClaims } | { ok: false; reason: "invalid" | "expired" | "wrong_org" };

function mac(body: string, secret: string): Buffer {
  const key = createHmac("sha256", secret).update(KEY_LABEL).digest();
  return createHmac("sha256", key).update(body).digest();
}

/** Signs the recommended product for `orgId`. */
export function signCheckoutToken(
  input: { orgId: string; name: string; priceMicro: MicroUsd; url?: string },
  secret: string,
  now: number = Date.now(),
): string {
  const claims: z.infer<typeof claimsSchema> = {
    v: 1,
    jti: randomUUID(),
    orgId: input.orgId,
    name: input.name,
    priceMicro: input.priceMicro.toString(),
    ...(input.url ? { url: input.url } : {}),
    exp: Math.floor(now / 1000) + CHECKOUT_TOKEN_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/**
 * Checks the signature, shape, expiry and that the token was issued to `orgId`.
 * Never throws.
 */
export function verifyCheckoutToken(
  token: string,
  secret: string,
  orgId: string,
  now: number = Date.now(),
): CheckoutTokenVerification {
  const [body, signature, ...rest] = token.split(".");
  if (!body || !signature || rest.length > 0) return { ok: false, reason: "invalid" };

  const given = Buffer.from(signature, "base64url");
  const expected = mac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const result = claimsSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: "invalid" };
  const claims = result.data;
  if (claims.orgId !== orgId) return { ok: false, reason: "wrong_org" };
  if (claims.exp <= Math.floor(now / 1000)) return { ok: false, reason: "expired" };
  return {
    ok: true,
    claims: {
      jti: claims.jti,
      orgId: claims.orgId,
      name: claims.name,
      priceMicro: BigInt(claims.priceMicro),
      ...(claims.url !== undefined ? { url: claims.url } : {}),
      exp: claims.exp,
    },
  };
}
