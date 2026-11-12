import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv as parseDotenv } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "../env";
import { createLlm, isAiBusy, llmConfigFromEnv, modelsFromConfig, type LlmConfig } from "./index";

/**
 * Calls the real Gemini API (and Groq, if its key is set). It runs only when
 * GEMINI_API_KEY is set and LLM_SMOKE=1, in the shell, .env.test.local or .env.local.
 * The flag is there because free-tier Flash allows only about 20 requests a day per
 * model (decision 0011), so a plain `npm test` must not spend them.
 *
 *   LLM_SMOKE=1 npx vitest run lib/llm/smoke.test.ts
 *
 * Each case uses at most one request per model.
 */

function readLocalEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const file of [".env.local", ".env.test.local"]) {
    const full = path.join(process.cwd(), file);
    if (existsSync(full)) Object.assign(merged, parseDotenv(readFileSync(full, "utf8")));
  }
  return { ...merged, ...withoutEmpty(process.env) };
}

function withoutEmpty(source: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value));
}

const local = readLocalEnv();
const enabled = Boolean(local.GEMINI_API_KEY) && local.LLM_SMOKE === "1";

function smokeConfig(): LlmConfig {
  // Only the AI variables matter here; the rest are placeholders so parseEnv's defaults
  // and validation apply exactly as in the app.
  const env = parseEnv({
    APP_BASE_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    RECEIPT_SIGNING_SECRET: "test-receipt-secret-0123456789abcdef",
    DEMO_UPSTREAM_SECRET: "test-demo-upstream-secret-0123456789",
    DATABASE_URL: "postgresql://unused@localhost/unused",
    DATABASE_URL_POOLED: "postgresql://unused@localhost/unused",
    PAYPAL_CLIENT_ID: "smoke",
    PAYPAL_CLIENT_SECRET: "smoke",
    NEXT_PUBLIC_PAYPAL_CLIENT_ID: "smoke",
    PAYPAL_DEMO_SHOP_EMAIL: "shop@example.com",
    GEMINI_API_KEY: local.GEMINI_API_KEY,
    GEMINI_MODEL: local.GEMINI_MODEL,
    GEMINI_FALLBACK_MODELS: local.GEMINI_FALLBACK_MODELS,
    GEMINI_EMBEDDING_MODEL: local.GEMINI_EMBEDDING_MODEL,
    GEMINI_EMBEDDING_DIMENSIONS: local.GEMINI_EMBEDDING_DIMENSIONS,
    GROQ_API_KEY: local.GROQ_API_KEY,
    GROQ_MODEL: local.GROQ_MODEL,
  });
  return llmConfigFromEnv(env);
}

/** Real fetch, except requests whose URL matches `fail` get a Gemini-style 429. */
function failingFor(fail: (url: string) => boolean) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!fail(url)) return fetch(input, init);
    return new Response(
      JSON.stringify({ error: { code: 429, message: "forced", status: "RESOURCE_EXHAUSTED" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  };
}

// A busy free tier is a real outcome, not a broken module, so AiBusy is reported as such.
function rethrowUnlessBusy(error: unknown): never {
  if (isAiBusy(error)) {
    throw new Error(`Gemini was busy for ${error.modelsTried.join(", ")}; try again later.`);
  }
  throw error;
}

describe.skipIf(!enabled)("lib/llm against the real Gemini API", () => {
  const config = enabled ? smokeConfig() : undefined;
  const timeout = 60_000;

  it(
    "gets structured output from the primary model",
    async () => {
      const llm = createLlm(
        modelsFromConfig({ ...config!, geminiFallbackModels: [], groqApiKey: "" }),
      );
      const answer = await llm
        .generateStructured({
          prompt: "Return the integer 2 + 2 as `sum`, and the word 'ok' as `status`.",
          schema: z.object({ sum: z.number().int(), status: z.string() }),
        })
        .catch(rethrowUnlessBusy);
      expect(answer.sum).toBe(4);
    },
    timeout,
  );

  it(
    "falls back to the next Gemini model when the primary is forced to 429",
    async () => {
      const primary = config!.geminiModel;
      const next = config!.geminiFallbackModels[0];
      expect(next, "GEMINI_FALLBACK_MODELS needs at least one model").toBeDefined();
      const llm = createLlm(
        modelsFromConfig(
          { ...config!, geminiFallbackModels: [next!], groqApiKey: "" },
          failingFor((url) => url.includes(`/models/${primary}:`)),
        ),
      );
      const result = await llm
        .generateText({ prompt: "Reply with the single word: pong" })
        .catch(rethrowUnlessBusy);
      expect(result.text.toLowerCase()).toContain("pong");
    },
    timeout,
  );

  it.skipIf(!local.GROQ_API_KEY)(
    "falls back to Groq when every Gemini model is forced to 429",
    async () => {
      const llm = createLlm(
        modelsFromConfig(
          config!,
          failingFor((url) => url.includes("generativelanguage.googleapis.com")),
        ),
      );
      const result = await llm.generateText({ prompt: "Reply with the single word: pong" });
      expect(result.text.toLowerCase()).toContain("pong");
    },
    timeout,
  );

  it(
    "embeds at the configured dimensions",
    async () => {
      const llm = createLlm(modelsFromConfig(config!));
      const vector = await llm.embed("product prices").catch(rethrowUnlessBusy);
      expect(vector).toHaveLength(config!.embeddingDimensions);
    },
    timeout,
  );
});
