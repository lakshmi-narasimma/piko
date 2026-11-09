import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signReceipt, verifyReceipt, type ReceiptClaims } from "./receipt";

const secret = "test-secret";
const claims: ReceiptClaims = {
  nonce: "c_1",
  agentId: "agent",
  orgId: "org",
  sellerId: "seller",
  endpointId: "endpoint",
  amount: "2000",
  exp: 2_000,
};

describe("Receipts", () => {
  it("round-trips the claims", () => {
    const verification = verifyReceipt(signReceipt(claims, secret), secret, 1_000);
    expect(verification).toEqual({ ok: true, claims });
  });

  it("uses HS256 and writes no other header fields", () => {
    const [header] = signReceipt(claims, secret).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
  });

  it("rejects an expired Receipt", () => {
    const token = signReceipt(claims, secret);
    expect(verifyReceipt(token, secret, 2_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a Receipt signed with another secret", () => {
    const token = signReceipt(claims, "other-secret");
    expect(verifyReceipt(token, secret, 1_000)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a Receipt whose amount was changed after signing", () => {
    const [header, , signature] = signReceipt(claims, secret).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...claims, amount: "1" })).toString("base64url");
    expect(verifyReceipt(`${header}.${tampered}.${signature}`, secret, 1_000)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a token that picks another algorithm, even one correctly signed for it", () => {
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const input = `${none}.${payload}`;
    const signature = createHmac("sha256", secret).update(input).digest("base64url");

    expect(verifyReceipt(`${input}.${signature}`, secret, 1_000)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(verifyReceipt(`${input}.`, secret, 1_000)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects malformed tokens and missing claims", () => {
    expect(verifyReceipt("not-a-jwt", secret).ok).toBe(false);
    const { amount: _amount, ...withoutAmount } = claims;
    const token = signReceipt(withoutAmount as ReceiptClaims, secret);
    expect(verifyReceipt(token, secret, 1_000).ok).toBe(false);
  });
});
