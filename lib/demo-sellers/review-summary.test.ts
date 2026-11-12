import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as cheapReviews } from "@/app/api/demo/sellers/cheap-reviews/summarise/route";
import { POST as reviewSummariser } from "@/app/api/demo/sellers/review-summariser/summarise/route";
import { createLlm, type Llm } from "@/lib/llm";
import { stubGatewayEnv, TEST_DEMO_UPSTREAM_SECRET } from "@/test/gateway-fixtures";

// The routes call getLlm(); swap in a real Llm over mock models so no provider is ever called.
const current = vi.hoisted(() => ({ llm: undefined as Llm | undefined }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  getLlm: () => {
    if (!current.llm) throw new Error("test did not set an Llm");
    return current.llm;
  },
}));

const SUMMARY = {
  sentiment: "positive",
  pros: ["Sharp picture", "Good stand"],
  cons: ["Weak speakers"],
  verdict: "A strong 4K monitor for work; buy speakers separately.",
};

function reply(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  };
}

function useModel(
  doGenerate: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>,
) {
  const model = new MockLanguageModelV4({
    provider: "google.generative-ai",
    modelId: "gemini-test",
    doGenerate,
  });
  current.llm = createLlm(
    {
      chain: [model],
      embedding: new MockEmbeddingModelV4({ provider: "google.generative-ai", modelId: "e" }),
      embeddingDimensions: 768,
    },
    { logger: { info: () => {}, warn: () => {} }, attemptTimeoutMs: 1_000 },
  );
  return model;
}

function post(body: unknown, secret: string | null = TEST_DEMO_UPSTREAM_SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Piko-Secret"] = secret;
  return new Request("http://localhost/api/demo/sellers/review-summariser/summarise", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function promptText(options: LanguageModelV4CallOptions | undefined): string {
  if (!options) throw new Error("the model was not called");
  return JSON.stringify(options.prompt);
}

beforeEach(() => {
  current.llm = undefined;
  stubGatewayEnv();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each([
  ["Review Summariser", reviewSummariser],
  ["Cheap Reviews", cheapReviews],
])("%s route", (_name, route) => {
  it.each([
    ["no X-Piko-Secret", null],
    ["a wrong X-Piko-Secret", "not-the-secret"],
  ])("answers 401 for %s without calling the model", async (_case, secret) => {
    const model = useModel(async () => reply(JSON.stringify(SUMMARY)));
    const response = await route(post({ reviews: ["Great."] }, secret));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each([
    ["not JSON", "{nope"],
    ["missing reviews", { product: "Monitor" }],
    ["empty string", { reviews: "   " }],
    ["empty list", { reviews: [] }],
    ["a blank review", { reviews: ["fine", ""] }],
    ["a non-string review", { reviews: [42] }],
    ["too many reviews", { reviews: Array.from({ length: 51 }, () => "ok") }],
    ["an oversized review", { reviews: ["x".repeat(2_001)] }],
    ["an oversized product", { reviews: ["ok"], product: "x".repeat(201) }],
  ])("rejects %s with 400 invalid_request", async (_case, body) => {
    const model = useModel(async () => reply(JSON.stringify(SUMMARY)));
    const response = await route(post(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("returns the structured summary", async () => {
    useModel(async () => reply(JSON.stringify(SUMMARY)));
    const response = await route(
      post({ product: "27-inch 4K Monitor", reviews: ["Sharp picture.", "Speakers are weak."] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      product: "27-inch 4K Monitor",
      reviewCount: 2,
      ...SUMMARY,
    });
  });

  it("accepts reviews as one string and no product", async () => {
    useModel(async () => reply(JSON.stringify(SUMMARY)));
    const body = await (await route(post({ reviews: "Great monitor." }))).json();

    expect(body.product).toBeNull();
    expect(body.reviewCount).toBe(1);
  });

  it("maps AiBusy to 503 ai_busy without leaking provider details", async () => {
    useModel(async () => {
      throw new APICallError({
        message: "SECRET provider text",
        url: "https://provider.test",
        requestBodyValues: { key: "SECRET-KEY" },
        statusCode: 429,
      });
    });
    const response = await route(post({ reviews: ["Great."] }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text).error.code).toBe("ai_busy");
    expect(text).not.toContain("SECRET");
  });
});

describe("Review tiers", () => {
  const reviews = Array.from({ length: 8 }, (_, index) => `Review text ${index + 1}`);

  it("Review Summariser reads every review", async () => {
    const model = useModel(async () => reply(JSON.stringify(SUMMARY)));
    const body = await (await reviewSummariser(post({ reviews }))).json();

    expect(body.reviewCount).toBe(8);
    expect(promptText(model.doGenerateCalls[0])).toContain("Review text 8");
  });

  it("Cheap Reviews reads only the first five, with a terser prompt", async () => {
    const model = useModel(async () => reply(JSON.stringify(SUMMARY)));
    const body = await (await cheapReviews(post({ reviews }))).json();

    expect(body.reviewCount).toBe(5);
    const prompt = promptText(model.doGenerateCalls[0]);
    expect(prompt).toContain("Review text 5");
    expect(prompt).not.toContain("Review text 6");
    expect(prompt).toContain("very briefly");
  });
});
