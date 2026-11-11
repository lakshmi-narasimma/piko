import { APICallError, simulateReadableStream } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createLlm } from "../llm";
import { runAgent, type AgentEvent } from "./run";
import type { AgentToolContext } from "./tools";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** One model step: some text, then optionally a tool call, then the finish. */
function step(text: string, call?: { name: string; input: unknown }) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "t" },
        { type: "text-delta" as const, id: "t", delta: text },
        { type: "text-end" as const, id: "t" },
        ...(call
          ? [
              {
                type: "tool-call" as const,
                toolCallId: `call-${call.name}`,
                toolName: call.name,
                input: JSON.stringify(call.input),
              },
            ]
          : []),
        {
          type: "finish" as const,
          finishReason: {
            unified: call ? ("tool-calls" as const) : ("stop" as const),
            raw: undefined,
          },
          usage,
        },
      ],
    }),
  };
}

function llmWith(model: MockLanguageModelV4) {
  return createLlm(
    {
      chain: [model],
      embedding: new MockEmbeddingModelV4({
        modelId: "e",
        doEmbed: async () => ({ embeddings: [], usage: { tokens: 0 }, warnings: [] }),
      }),
      embeddingDimensions: 768,
    },
    { logger: { info() {}, warn() {} }, attemptTimeoutMs: 1_000 },
  );
}

function context(): AgentToolContext {
  const settlement = Buffer.from(JSON.stringify({ success: true, amount: "2000" })).toString(
    "base64",
  );
  return {
    key: "pk_agent_secret",
    baseUrl: "http://localhost:3000",
    taskBudgetMicro: 100_000n,
    state: { spentMicro: 0n },
    search: vi.fn(async () => []),
    lookupPrice: vi.fn(async () => 2_000n),
    walletBalance: vi.fn(async () => 5_000_000n),
    send: vi.fn(
      async () => new Response("[]", { status: 200, headers: { "PAYMENT-RESPONSE": settlement } }),
    ),
  };
}

async function collect(events: AsyncGenerator<AgentEvent>) {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("runAgent", () => {
  it("reasons, pays for a call, recommends, answers and reports what it spent", async () => {
    const model = new MockLanguageModelV4({
      modelId: "gemini-3.6-flash",
      doStream: [
        step("Price History costs $0.002 and shows if the price is fair.", {
          name: "call_api",
          input: { seller: "priya", path: "/history", method: "GET", query: { product: "p1" } },
        }),
        step("", { name: "recommend_product", input: { name: "LG 27UP850", priceUsd: "279.99" } }),
        step("I recommend the LG 27UP850 at $279.99. I spent $0.002."),
      ],
    });
    const ctx = context();
    const events = await collect(runAgent({ llm: llmWith(model), ctx, prompt: "find a monitor" }));

    expect(events.map((e) => e.type)).toEqual([
      "reasoning",
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "answer",
      "done",
    ]);
    expect(events[2]).toMatchObject({
      type: "tool-result",
      name: "call_api",
      ok: true,
      costMicro: "2000",
      cost: "$0.002",
    });
    expect(events[0]).toMatchObject({ type: "reasoning", text: expect.stringContaining("$0.002") });
    expect(events.at(-1)).toEqual({
      type: "done",
      spentMicro: "2000",
      spent: "$0.002",
      remaining: "$0.098",
      recommendation: { name: "LG 27UP850", priceMicro: "279990000", url: undefined },
    });
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it("puts the task budget in the instructions", async () => {
    const model = new MockLanguageModelV4({ modelId: "m", doStream: async () => step("ok") });
    await collect(runAgent({ llm: llmWith(model), ctx: context(), prompt: "hi" }));
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("$0.10");
  });

  it("turns a busy model into a busy event, and still finishes with done", async () => {
    const model = new MockLanguageModelV4({
      modelId: "gemini-3.6-flash",
      doStream: async () => {
        throw new APICallError({
          message: "429",
          url: "https://provider.test",
          requestBodyValues: {},
          statusCode: 429,
        });
      },
    });
    const events = await collect(runAgent({ llm: llmWith(model), ctx: context(), prompt: "hi" }));
    expect(events.map((e) => e.type)).toEqual(["busy", "done"]);
  });

  it("reports a tool that throws instead of crashing", async () => {
    const model = new MockLanguageModelV4({
      modelId: "m",
      doStream: [step("Checking.", { name: "check_budget", input: {} }), step("Done.")],
    });
    const ctx = context();
    ctx.walletBalance = vi.fn(async () => {
      throw new Error("db down");
    });
    const events = await collect(runAgent({ llm: llmWith(model), ctx, prompt: "hi" }));
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ ok: false });
    expect(events.at(-1)?.type).toBe("done");
  });
});
