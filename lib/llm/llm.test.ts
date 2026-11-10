import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  APICallError,
  isStepCount,
  NoObjectGeneratedError,
  simulateReadableStream,
  tool,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiBusy, AttemptTimeout, busyReason } from "./errors";
import {
  AI_BUSY_MESSAGE,
  createLlm,
  isAiBusy,
  modelsFromConfig,
  type LlmConfig,
  type LlmLogger,
  type LlmModels,
} from "./index";

const PROMPT = "SECRET-PROMPT summarise these reviews";
const GEMINI_KEY = "SECRET-GEMINI-KEY";
const GROQ_KEY = "SECRET-GROQ-KEY";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function reply(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

/** The SDK's error for a failed provider call. It carries the request body, i.e. the prompt. */
function httpError(status: number) {
  return new APICallError({
    message: `HTTP ${status} from provider`,
    url: "https://provider.test/v1",
    requestBodyValues: { prompt: PROMPT },
    statusCode: status,
  });
}

function gemini(modelId: string, behaviour: string | number | Error) {
  return mockModel("google.generative-ai", modelId, behaviour);
}

function groq(modelId: string, behaviour: string | number | Error) {
  return mockModel("groq.chat", modelId, behaviour);
}

function mockModel(provider: string, modelId: string, behaviour: string | number | Error) {
  return new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: async () => {
      if (typeof behaviour === "string") return reply(behaviour);
      throw typeof behaviour === "number" ? httpError(behaviour) : behaviour;
    },
  });
}

function embedder(doEmbed: MockEmbeddingModelV4["doEmbed"]) {
  return new MockEmbeddingModelV4({
    provider: "google.generative-ai",
    modelId: "gemini-embedding-2",
    doEmbed,
  });
}

const vector = (size: number, value = 0.1) => Array.from({ length: size }, () => value);
const unusedEmbedder = embedder(async () => {
  throw new Error("not used");
});

function recordingLogger() {
  const lines: string[] = [];
  const logger: LlmLogger = {
    info: (line) => lines.push(`info ${line}`),
    warn: (line) => lines.push(`warn ${line}`),
  };
  return { lines, logger };
}

function llmWith(chain: MockLanguageModelV4[], extra: Partial<LlmModels> = {}) {
  const { lines, logger } = recordingLogger();
  const models: LlmModels = {
    chain,
    embedding: unusedEmbedder,
    embeddingDimensions: 768,
    ...extra,
  };
  return { llm: createLlm(models, { logger, attemptTimeoutMs: 1_000 }), lines };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("generateText fallback chain", () => {
  it("answers from the first model when it succeeds", async () => {
    const primary = gemini("gemini-3.6-flash", "hello");
    const fallback = gemini("gemini-3-flash-preview", "unused");
    const { llm, lines } = llmWith([primary, fallback]);

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("hello");
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(lines).toEqual(["info llm: answered by google:gemini-3.6-flash"]);
  });

  it("moves to the next Gemini model when the first returns 429", async () => {
    const primary = gemini("gemini-3.6-flash", 429);
    const preview = gemini("gemini-3-flash-preview", "from preview");
    const lite = gemini("gemini-3.5-flash-lite", "unused");
    const { llm, lines } = llmWith([primary, preview, lite]);

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("from preview");
    expect([primary, preview, lite].map((m) => m.doGenerateCalls.length)).toEqual([1, 1, 0]);
    expect(lines).toEqual([
      "warn llm: google:gemini-3.6-flash skipped (rate_limited, HTTP 429), trying google:gemini-3-flash-preview",
      "info llm: answered by google:gemini-3-flash-preview after skipping google:gemini-3.6-flash (rate_limited, HTTP 429)",
    ]);
  });

  it("falls back to Groq when every Gemini model is rate-limited or overloaded", async () => {
    const chain = [
      gemini("gemini-3.6-flash", 429),
      gemini("gemini-3-flash-preview", 503),
      gemini("gemini-3.5-flash-lite", 500),
      groq("openai/gpt-oss-120b", "from groq"),
    ];
    const { llm } = llmWith(chain);

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("from groq");
    expect(chain.map((m) => m.doGenerateCalls.length)).toEqual([1, 1, 1, 1]);
  });

  it("throws AiBusy listing every model tried when the whole chain is busy", async () => {
    const { llm, lines } = llmWith([
      gemini("gemini-3.6-flash", 429),
      gemini("gemini-3-flash-preview", 404),
      gemini("gemini-3.5-flash-lite", 503),
      groq("openai/gpt-oss-120b", 498),
    ]);

    const error = await rejection(llm.generateText({ prompt: PROMPT }));

    expect(error).toBeInstanceOf(AiBusy);
    expect(isAiBusy(error)).toBe(true);
    const busy = error as AiBusy;
    expect(busy.name).toBe("AiBusy");
    expect(busy.code).toBe("ai_busy");
    expect(busy.message).toBe(AI_BUSY_MESSAGE);
    expect(busy.modelsTried).toEqual([
      "google:gemini-3.6-flash",
      "google:gemini-3-flash-preview",
      "google:gemini-3.5-flash-lite",
      "groq:openai/gpt-oss-120b",
    ]);
    expect(busy.attempts.map((a) => a.reason)).toEqual([
      "rate_limited",
      "model_unavailable",
      "overloaded",
      "overloaded",
    ]);
    // No cause, so the SDK error (which holds the prompt) can't leak through the UI or logs.
    expect(busy.cause).toBeUndefined();
    expect(JSON.stringify({ ...busy, message: busy.message })).not.toContain("SECRET");
    expect(lines.at(-1)).toBe(
      "warn llm: groq:openai/gpt-oss-120b skipped (overloaded, HTTP 498), no models left",
    );
  });

  it("rethrows a non-retryable error without trying the next model", async () => {
    const badRequest = httpError(400);
    const primary = gemini("gemini-3.6-flash", badRequest);
    const fallback = gemini("gemini-3-flash-preview", "unused");
    const { llm } = llmWith([primary, fallback]);

    const error = await rejection(llm.generateText({ prompt: PROMPT }));

    expect(error).toBe(badRequest);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it.each([401, 403, 422])("does not fall back on HTTP %i", async (status) => {
    const fallback = gemini("gemini-3-flash-preview", "unused");
    const { llm } = llmWith([gemini("gemini-3.6-flash", status), fallback]);

    const error = await rejection(llm.generateText({ prompt: PROMPT }));

    expect(APICallError.isInstance(error) && error.statusCode).toBe(status);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("moves on when an attempt runs past the per-attempt timeout", async () => {
    const hanging = new MockLanguageModelV4({
      provider: "google.generative-ai",
      modelId: "gemini-3.6-flash",
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) =>
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason)),
        ),
    });
    const fallback = gemini("gemini-3-flash-preview", "after timeout");
    const { logger } = recordingLogger();
    const llm = createLlm(
      { chain: [hanging, fallback], embedding: unusedEmbedder, embeddingDimensions: 768 },
      { logger, attemptTimeoutMs: 20 },
    );

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("after timeout");
  });

  it("does not fall back when the caller aborts", async () => {
    const controller = new AbortController();
    const primary = new MockLanguageModelV4({
      modelId: "gemini-3.6-flash",
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
          controller.abort();
        }),
    });
    const fallback = gemini("gemini-3-flash-preview", "unused");
    const { llm } = llmWith([primary, fallback]);

    const error = await rejection(
      llm.generateText({ prompt: PROMPT, abortSignal: controller.signal }),
    );

    expect(isAiBusy(error)).toBe(false);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("keeps later tool-loop steps on the model that answered", async () => {
    const primary = gemini("gemini-3.6-flash", 429);
    const preview = new MockLanguageModelV4({
      provider: "google.generative-ai",
      modelId: "gemini-3-flash-preview",
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "budgetLeft",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        reply("You have $0.08 left."),
      ],
    });
    const { llm } = llmWith([primary, preview]);

    const result = await llm.generateText({
      prompt: PROMPT,
      tools: {
        budgetLeft: tool({
          description: "Budget left for this task, in micro-USD.",
          inputSchema: z.object({}),
          execute: async () => ({ remainingMicro: "80000" }),
        }),
      },
      stopWhen: isStepCount(3),
    });

    expect(result.text).toBe("You have $0.08 left.");
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(preview.doGenerateCalls).toHaveLength(2);
  });

  it("never logs the prompt or an API key", async () => {
    const { llm, lines } = llmWith([
      gemini("gemini-3.6-flash", 429),
      gemini("gemini-3-flash-preview", 400),
    ]);

    await rejection(llm.generateText({ prompt: PROMPT }));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});

describe("streamText", () => {
  const streamOf = (text: string) => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "t" },
        { type: "text-delta" as const, id: "t", delta: text },
        { type: "text-end" as const, id: "t" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  });

  async function parts(stream: AsyncIterable<TextStreamPart<ToolSet>>) {
    const seen: TextStreamPart<ToolSet>[] = [];
    for await (const part of stream) seen.push(part);
    return seen;
  }

  it("falls back before the stream starts", async () => {
    const primary = new MockLanguageModelV4({
      modelId: "gemini-3.6-flash",
      doStream: async () => {
        throw httpError(503);
      },
    });
    const preview = new MockLanguageModelV4({
      modelId: "gemini-3-flash-preview",
      doStream: async () => streamOf("streamed"),
    });
    const { llm } = llmWith([primary, preview]);

    const result = llm.streamText({ prompt: PROMPT });

    expect(await result.text).toBe("streamed");
    expect(primary.doStreamCalls).toHaveLength(1);
  });

  it("delivers AiBusy as an error part when every model is busy", async () => {
    const busyModel = (modelId: string) =>
      new MockLanguageModelV4({
        modelId,
        doStream: async () => {
          throw httpError(429);
        },
      });
    const { llm } = llmWith([busyModel("gemini-3.6-flash"), busyModel("gemini-3-flash-preview")]);

    const result = llm.streamText({ prompt: PROMPT, onError: () => {} });
    const errors = (await parts(result.stream)).filter((part) => part.type === "error");

    expect(errors).toHaveLength(1);
    expect(isAiBusy(errors[0]?.error)).toBe(true);
  });
});

describe("generateStructured", () => {
  const policySchema = z.object({
    rule: z.enum(["max_per_call", "daily_cap"]),
    amountMicro: z.string().regex(/^\d+$/),
  });

  it("returns output validated against the zod schema", async () => {
    const { llm } = llmWith([
      gemini("gemini-3.6-flash", '{"rule":"max_per_call","amountMicro":"50000"}'),
    ]);

    const policy = await llm.generateStructured({ prompt: PROMPT, schema: policySchema });

    expect(policy).toEqual({ rule: "max_per_call", amountMicro: "50000" });
  });

  it("falls back on 429 for structured output too", async () => {
    const { llm } = llmWith([
      gemini("gemini-3.6-flash", 429),
      groq("openai/gpt-oss-120b", '{"rule":"daily_cap","amountMicro":"1000000"}'),
    ]);

    const policy = await llm.generateStructured({ prompt: PROMPT, schema: policySchema });

    expect(policy.rule).toBe("daily_cap");
  });

  it("treats an invalid shape as a real error, not as busy", async () => {
    const primary = gemini("gemini-3.6-flash", '{"rule":"spend_everything","amountMicro":"-1"}');
    const fallback = gemini("gemini-3-flash-preview", '{"rule":"daily_cap","amountMicro":"1"}');
    const { llm } = llmWith([primary, fallback]);

    const error = await rejection(llm.generateStructured({ prompt: PROMPT, schema: policySchema }));

    expect(NoObjectGeneratedError.isInstance(error)).toBe(true);
    expect(isAiBusy(error)).toBe(false);
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });
});

describe("embeddings", () => {
  it("embeds one value at the configured dimensions", async () => {
    const model = embedder(async ({ values }) => ({
      embeddings: values.map(() => vector(768)),
      warnings: [],
    }));
    const { llm } = llmWith([], { embedding: model });

    const result = await llm.embed("product prices");

    expect(result).toHaveLength(768);
    expect(model.doEmbedCalls[0]?.dimensions).toBe(768);
  });

  it("embeds a batch in order", async () => {
    const model = embedder(async ({ values }) => ({
      // Tag each vector with its input, since the SDK may split the batch across calls.
      embeddings: values.map((value) => vector(768, Number(value))),
      warnings: [],
    }));
    const { llm } = llmWith([], { embedding: model });

    const result = await llm.embedMany(["1", "2", "3"]);

    expect(result.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(result.every((v) => v.length === 768)).toBe(true);
  });

  it("throws AiBusy when the embedding model is rate-limited, with no other model tried", async () => {
    const model = embedder(async () => {
      throw httpError(429);
    });
    const { llm } = llmWith([], { embedding: model });

    const error = await rejection(llm.embed("product prices"));

    expect(isAiBusy(error)).toBe(true);
    expect((error as AiBusy).modelsTried).toEqual(["google:gemini-embedding-2"]);
    expect(model.doEmbedCalls).toHaveLength(1);
  });

  it("rejects a vector of the wrong size instead of storing it", async () => {
    const model = embedder(async () => ({ embeddings: [vector(3072)], warnings: [] }));
    const { llm } = llmWith([], { embedding: model });

    const error = await rejection(llm.embed("product prices"));

    expect(isAiBusy(error)).toBe(false);
    expect((error as Error).message).toMatch(/returned 3072 dimensions, expected 768/);
  });
});

describe("busyReason", () => {
  it.each([
    [429, "rate_limited"],
    [503, "overloaded"],
    [498, "overloaded"],
    [500, "server_error"],
    [502, "server_error"],
    [504, "server_error"],
    [408, "timeout"],
    [404, "model_unavailable"],
  ])("treats HTTP %i as %s", (status, reason) => {
    expect(busyReason(httpError(status))?.reason).toBe(reason);
  });

  it.each([400, 401, 403, 409, 413, 422])("does not treat HTTP %i as busy", (status) => {
    expect(busyReason(httpError(status))).toBeNull();
  });

  it("treats a failed connection and our own timeout as busy, and anything else as not", () => {
    const unreachable = new APICallError({
      message: "Cannot connect to API",
      url: "https://provider.test",
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(busyReason(unreachable)?.reason).toBe("unreachable");
    expect(busyReason(new AttemptTimeout())?.reason).toBe("timeout");
    expect(busyReason(new Error("bug"))).toBeNull();
    expect(busyReason(new DOMException("aborted", "AbortError"))).toBeNull();
  });
});

/**
 * The real Google and Groq adapters, with a fake fetch in place of the network. This
 * checks the chain built from config and that the adapters' HTTP errors classify as busy.
 */
describe("modelsFromConfig with the real provider adapters", () => {
  const config: LlmConfig = {
    geminiApiKey: GEMINI_KEY,
    geminiModel: "gemini-3.6-flash",
    geminiFallbackModels: ["gemini-3-flash-preview", "gemini-3.5-flash-lite"],
    embeddingModel: "gemini-embedding-2",
    embeddingDimensions: 768,
    groqApiKey: "",
    groqModel: "openai/gpt-oss-120b",
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const geminiQuotaError = () =>
    json(429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } });

  function fakeFetch(respond: (url: string, body: string) => Response) {
    const requests: { url: string; body: string; headers: Headers }[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({ url, body, headers: new Headers(init?.headers) });
      return respond(url, body);
    };
    return { fetch, requests };
  }

  it("is Gemini only without a Groq key, and ends in AiBusy", async () => {
    const { fetch, requests } = fakeFetch(geminiQuotaError);
    const { logger, lines } = recordingLogger();
    const llm = createLlm(modelsFromConfig(config, fetch), { logger });

    const error = await rejection(llm.generateText({ prompt: PROMPT }));

    expect(isAiBusy(error)).toBe(true);
    expect((error as AiBusy).modelsTried).toEqual([
      "google:gemini-3.6-flash",
      "google:gemini-3-flash-preview",
      "google:gemini-3.5-flash-lite",
    ]);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1beta/models/gemini-3.6-flash:generateContent",
      "/v1beta/models/gemini-3-flash-preview:generateContent",
      "/v1beta/models/gemini-3.5-flash-lite:generateContent",
    ]);
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("ends with Groq when GROQ_API_KEY is set", async () => {
    const { fetch, requests } = fakeFetch((url) =>
      url.includes("api.groq.com")
        ? json(200, {
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "openai/gpt-oss-120b",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "groq answered" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        : geminiQuotaError(),
    );
    const { logger } = recordingLogger();
    const llm = createLlm(modelsFromConfig({ ...config, groqApiKey: GROQ_KEY }, fetch), {
      logger,
    });

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("groq answered");
    expect(requests).toHaveLength(4);
    expect(requests[3]?.headers.get("authorization")).toBe(`Bearer ${GROQ_KEY}`);
  });

  it("moves on when a provider can't be reached", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.includes("gemini-3.6-flash")) {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      }
      return json(200, {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "preview answered" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    });
    const { logger } = recordingLogger();
    const llm = createLlm(modelsFromConfig(config, fetch), { logger });

    const result = await llm.generateText({ prompt: PROMPT });

    expect(result.text).toBe("preview answered");
  });

  it("asks Gemini for the configured embedding size", async () => {
    const { fetch, requests } = fakeFetch(() => json(200, { embedding: { values: vector(768) } }));
    const { logger } = recordingLogger();
    const llm = createLlm(modelsFromConfig(config, fetch), { logger });

    const result = await llm.embed("product prices");

    expect(result).toHaveLength(768);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ outputDimensionality: 768 });
  });
});
