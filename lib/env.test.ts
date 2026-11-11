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
    expect(env.GEMINI_MODEL).toBe("gemini-3.6-flash");
    expect(env.PLATFORM_FEE_BPS).toBe(500);
    expect(env.PAYOUT_THRESHOLD_MICRO).toBe(1_000_000n);
    expect(env.DEMO_MODE).toBe(false);
  });

  it("allows the webhook id, Groq key and Gemini model to be empty", () => {
    const env = parseEnv({ ...valid, PAYPAL_WEBHOOK_ID: "", GROQ_API_KEY: "", GEMINI_MODEL: "" });
    expect(env.PAYPAL_WEBHOOK_ID).toBe("");
    expect(env.GROQ_API_KEY).toBe("");
    expect(env.GEMINI_MODEL).toBe("gemini-3.6-flash");
  });

  it("defaults the AI chain to the models pinned in decision 0011", () => {
    const env = parseEnv(valid);
    expect(env.GEMINI_FALLBACK_MODELS).toEqual(["gemini-3-flash-preview", "gemini-3.5-flash-lite"]);
    expect(env.GEMINI_EMBEDDING_MODEL).toBe("gemini-embedding-2");
    expect(env.GEMINI_EMBEDDING_DIMENSIONS).toBe(768);
    expect(env.GROQ_MODEL).toBe("openai/gpt-oss-120b");
  });

  it("reads the fallback models as a trimmed comma-separated list without repeats", () => {
    const env = parseEnv({
      ...valid,
      GEMINI_FALLBACK_MODELS:
        " gemini-3-flash-preview , ,gemini-3.5-flash-lite,gemini-3-flash-preview",
      GEMINI_EMBEDDING_DIMENSIONS: "1536",
    });
    expect(env.GEMINI_FALLBACK_MODELS).toEqual(["gemini-3-flash-preview", "gemini-3.5-flash-lite"]);
    expect(env.GEMINI_EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it("rejects -latest aliases and impossible embedding sizes, naming the variable", () => {
    let error: unknown;
    try {
      parseEnv({
        ...valid,
        GEMINI_MODEL: "gemini-flash-latest",
        GEMINI_FALLBACK_MODELS: "gemini-3-flash-preview,gemini-flash-lite-latest",
        GEMINI_EMBEDDING_DIMENSIONS: "4096",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvError);
    const issues = (error as EnvError).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        "GEMINI_MODEL: must be a pinned model id, not a -latest alias",
        "GEMINI_FALLBACK_MODELS: must be a pinned model id, not a -latest alias",
      ]),
    );
    expect(issues.some((issue) => issue.startsWith("GEMINI_EMBEDDING_DIMENSIONS: "))).toBe(true);
    expect(issues.join(" ")).not.toMatch(/flash-lite-latest|4096/);
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

  it("parses the Gemini fallback list and embedding dimensions", () => {
    const env = parseEnv({
      ...valid,
      GEMINI_FALLBACK_MODELS: " model-a , model-b.1 ,",
      GEMINI_EMBEDDING_DIMENSIONS: "1536",
    });
    expect(env.GEMINI_FALLBACK_MODELS).toEqual(["model-a", "model-b.1"]);
    expect(env.GEMINI_EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it("rejects a bad Gemini fallback list or embedding dimension count", () => {
    expect(() => parseEnv({ ...valid, GEMINI_FALLBACK_MODELS: "ok,not ok" })).toThrow(
      /GEMINI_FALLBACK_MODELS: must be a model id/,
    );
    expect(() => parseEnv({ ...valid, GEMINI_EMBEDDING_DIMENSIONS: "0" })).toThrow(
      /GEMINI_EMBEDDING_DIMENSIONS:/,
    );
    expect(() => parseEnv({ ...valid, GEMINI_EMBEDDING_DIMENSIONS: "7.5" })).toThrow(
      /GEMINI_EMBEDDING_DIMENSIONS:/,
    );
  });

  it("rejects a malformed value without echoing it", () => {
    expect(() => parseEnv({ ...valid, PAYOUT_THRESHOLD_MICRO: "1.5" })).toThrow(
      /PAYOUT_THRESHOLD_MICRO: must be a whole number/,
    );
    expect(() => parseEnv({ ...valid, PAYOUT_THRESHOLD_MICRO: "1.5" })).not.toThrow(/1\.5/);
  });
});
