import { describe, expect, it } from "vitest";
import { CHECKOUT_TOKEN_TTL_SECONDS, signCheckoutToken, verifyCheckoutToken } from "./token";

const SECRET = "s".repeat(32);
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const PRODUCT = {
  orgId: "org1",
  name: "LG 27UP850",
  priceMicro: 279_990_000n,
  url: "https://shop.example/lg",
};

function reencode(token: string, change: (claims: Record<string, unknown>) => void): string {
  const [body, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<string, unknown>;
  change(claims);
  return `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
}

describe("checkout tokens", () => {
  it("round-trips the product, price and org", () => {
    const token = signCheckoutToken(PRODUCT, SECRET, NOW);
    const result = verifyCheckoutToken(token, SECRET, "org1", NOW);
    expect(result).toMatchObject({ ok: true, claims: PRODUCT });
    if (result.ok) expect(result.claims.priceMicro).toBe(279_990_000n);
  });

  it("gives every token its own id", () => {
    const a = verifyCheckoutToken(signCheckoutToken(PRODUCT, SECRET, NOW), SECRET, "org1", NOW);
    const b = verifyCheckoutToken(signCheckoutToken(PRODUCT, SECRET, NOW), SECRET, "org1", NOW);
    expect(a.ok && b.ok && a.claims.jti !== b.claims.jti).toBe(true);
  });

  it("refuses a token whose price was changed", () => {
    const token = reencode(signCheckoutToken(PRODUCT, SECRET, NOW), (c) => {
      c.priceMicro = "1000000";
    });
    expect(verifyCheckoutToken(token, SECRET, "org1", NOW)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses a token signed with another secret, or malformed", () => {
    const other = signCheckoutToken(PRODUCT, "o".repeat(32), NOW);
    for (const token of [other, "", "abc", "a.b.c", `${other}x`]) {
      expect(verifyCheckoutToken(token, SECRET, "org1", NOW)).toMatchObject({ ok: false });
    }
  });

  it("refuses another org's token", () => {
    const token = signCheckoutToken(PRODUCT, SECRET, NOW);
    expect(verifyCheckoutToken(token, SECRET, "org2", NOW)).toEqual({
      ok: false,
      reason: "wrong_org",
    });
  });

  it("refuses an expired token", () => {
    const token = signCheckoutToken(PRODUCT, SECRET, NOW);
    const later = NOW + CHECKOUT_TOKEN_TTL_SECONDS * 1000;
    expect(verifyCheckoutToken(token, SECRET, "org1", later - 1000).ok).toBe(true);
    expect(verifyCheckoutToken(token, SECRET, "org1", later)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
