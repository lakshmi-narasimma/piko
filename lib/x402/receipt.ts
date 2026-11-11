/**
 * Receipts: HS256 JWTs signed with RECEIPT_SIGNING_SECRET (docs/API.md section 2).
 * Signed with node:crypto directly, since this project signs exactly one kind of token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

const claimsSchema = z.object({
  nonce: z.string().min(1),
  agentId: z.string().min(1),
  orgId: z.string().min(1),
  sellerId: z.string().min(1),
  endpointId: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  exp: z.number().int(),
});

export type ReceiptClaims = z.infer<typeof claimsSchema>;

export type ReceiptVerification =
  { ok: true; claims: ReceiptClaims } | { ok: false; reason: "invalid" | "expired" };

function sign(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

export function signReceipt(claims: ReceiptClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${JWT_HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret).toString("base64url")}`;
}

/**
 * Checks a Receipt's signature, shape and expiry. The header must be exactly the one
 * {@link signReceipt} writes, so a token can't pick its own algorithm.
 */
export function verifyReceipt(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ReceiptVerification {
  const [header, payload, signature, ...rest] = token.split(".");
  if (!header || !payload || !signature || rest.length > 0 || header !== JWT_HEADER) {
    return { ok: false, reason: "invalid" };
  }

  const expected = sign(`${header}.${payload}`, secret);
  const presented = Buffer.from(signature, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const claims = claimsSchema.safeParse(parsed);
  if (!claims.success) return { ok: false, reason: "invalid" };
  if (claims.data.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims.data };
}
