import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "./env";

const valid = {
  APP_BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "test-session-secret",
  RECEIPT_SIGNING_SECRET: "test-receipt-secret",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/piko",
  DATABASE_URL_POOLED: "postgresql://user:pass@localhost:5432/piko",
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_DEMO_SHOP_EMAIL: "shop@example.com",
  GEMINI_API_KEY: "gemini-key",
};

describe("parseEnv", () => {
  it("accepts the required variables and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.GEMINI_MODEL).toBe("gemini-flash-latest");
    expect(env.PLATFORM_FEE_BPS).toBe(500);
    expect(env.PAYOUT_THRESHOLD_MICRO).toBe(1_000_000n);
    expect(env.DEMO_MODE).toBe(false);
  });

  it("allows the webhook id, Groq key and Gemini model to be empty", () => {
    const env = parseEnv({ ...valid, PAYPAL_WEBHOOK_ID: "", GROQ_API_KEY: "", GEMINI_MODEL: "" });
    expect(env.PAYPAL_WEBHOOK_ID).toBe("");
    expect(env.GROQ_API_KEY).toBe("");
    expect(env.GEMINI_MODEL).toBe("gemini-flash-latest");
  });

  it("fails fast on a missing or blank required variable, naming it without its value", () => {
    const { DATABASE_URL_POOLED: _omitted, ...rest } = valid;
    let error: unknown;
    try {
      parseEnv({ ...rest, SESSION_SECRET: "" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual(
      expect.arrayContaining(["SESSION_SECRET: missing", "DATABASE_URL_POOLED: missing"]),
    );
  });

  it("rejects a malformed value without echoing it", () => {
    expect(() => parseEnv({ ...valid, PAYOUT_THRESHOLD_MICRO: "1.5" })).toThrow(
      /PAYOUT_THRESHOLD_MICRO: must be a whole number/,
    );
    expect(() => parseEnv({ ...valid, PAYOUT_THRESHOLD_MICRO: "1.5" })).not.toThrow(/1\.5/);
  });
});
