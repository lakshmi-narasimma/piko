/**
 * The budget-aware buyer agent: Gemini, through lib/llm, with the tools in ./tools. It
 * searches the Directory, weighs price against rating, pays for calls through the real x402
 * gateway, explains the cost of each choice, and stops near the task budget.
 *
 * Gemini only reasons here. What a call may cost is decided by Piko's own pay pipeline.
 */
import { isStepCount } from "ai";
import { AI_BUSY_MESSAGE, isAiBusy, type Llm } from "../llm";
import { formatUsd } from "../money";
import { createAgentTools, type AgentToolContext, type Recommendation } from "./tools";

export const MAX_AGENT_STEPS = 14;

export function agentInstructions(taskBudgetMicro: bigint): string {
  return `You are a shopping research agent. You work for a buyer and pay for API calls out of their wallet, per call. Your budget for this task is ${formatUsd(taskBudgetMicro)}. Spend as little of it as the job needs.

How to work:
1. Start with search_directory to see which APIs exist and what each endpoint costs. Searching is free.
2. Before every paid call_api, write ONE short sentence in plain words: which API, its price, and why that is worth paying for. Example: "Price History costs $0.002, and it shows whether this monitor's price is a good one."
3. Weigh price against rating. If a cheaper API is rated much lower, take the better one and say so in that sentence. Never pay two APIs for the same information.
4. Build evidence before you recommend: find candidates, then check the reviews and the price history of the one you like best.
5. Use check_budget if you are unsure. Stop spending when what is left can't cover another useful call.
6. Finish by calling recommend_product once with the single product, then reply with a short answer: the product, its price, why you chose it, and what you spent in total.

Prices are shown to you in dollars. Only use endpoints exactly as search_directory returned them. If a tool returns an error, don't repeat the same call: change approach or explain what you couldn't do.`;
}

/** What the playground screen renders, one per line of the live feed. */
export type AgentEvent =
  | { type: "reasoning"; text: string }
  | { type: "answer"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | {
      type: "tool-result";
      id: string;
      name: string;
      ok: boolean;
      costMicro: string;
      cost: string;
      output: unknown;
    }
  | { type: "busy"; message: string }
  | { type: "error"; message: string }
  | {
      type: "done";
      spentMicro: string;
      spent: string;
      remaining: string;
      recommendation: { name: string; priceMicro: string; url?: string } | null;
    };

function costOf(output: unknown): { costMicro: string; cost: string; ok: boolean } {
  const o = (output ?? {}) as { costMicro?: unknown; cost?: unknown; ok?: unknown };
  return {
    costMicro: typeof o.costMicro === "string" ? o.costMicro : "0",
    cost: typeof o.cost === "string" ? o.cost : formatUsd(0n),
    ok: o.ok !== false,
  };
}

function doneEvent(ctx: AgentToolContext): AgentEvent {
  const left = ctx.taskBudgetMicro - ctx.state.spentMicro;
  const rec: Recommendation | undefined = ctx.state.recommendation;
  return {
    type: "done",
    spentMicro: ctx.state.spentMicro.toString(),
    spent: formatUsd(ctx.state.spentMicro),
    remaining: formatUsd(left > 0n ? left : 0n),
    recommendation: rec
      ? { name: rec.name, priceMicro: rec.priceMicro.toString(), url: rec.url }
      : null,
  };
}

/**
 * Runs the agent on `prompt` and yields what it does as it does it. Never throws: a busy model
 * becomes a `busy` event and anything else an `error` event, and `done` always comes last.
 */
export async function* runAgent(input: {
  llm: Pick<Llm, "streamText">;
  ctx: AgentToolContext;
  prompt: string;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const { llm, ctx, prompt, abortSignal } = input;
  const tools = createAgentTools(ctx);
  let stepText = "";

  try {
    const result = llm.streamText({
      instructions: agentInstructions(ctx.taskBudgetMicro),
      prompt,
      tools,
      stopWhen: isStepCount(input.maxSteps ?? MAX_AGENT_STEPS),
      abortSignal,
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          stepText += part.text;
          break;
        case "tool-call": {
          // Text before a tool call is the agent explaining the call, so show it first.
          const thought = stepText.trim();
          stepText = "";
          if (thought) yield { type: "reasoning", text: thought };
          yield { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input };
          break;
        }
        case "tool-result":
          yield {
            type: "tool-result",
            id: part.toolCallId,
            name: part.toolName,
            output: part.output,
            ...costOf(part.output),
          };
          break;
        case "tool-error":
          yield {
            type: "tool-result",
            id: part.toolCallId,
            name: part.toolName,
            ok: false,
            costMicro: "0",
            cost: formatUsd(0n),
            output: { ok: false, error: "tool_failed", message: "The tool failed." },
          };
          break;
        case "finish-step": {
          const text = stepText.trim();
          stepText = "";
          if (text) {
            // Text in a step that goes on to call tools is the agent thinking out loud.
            yield { type: part.finishReason === "tool-calls" ? "reasoning" : "answer", text };
          }
          break;
        }
        case "error":
          yield errorEvent(part.error);
          break;
      }
    }
  } catch (error) {
    yield errorEvent(error);
  }
  yield doneEvent(ctx);
}

function errorEvent(error: unknown): AgentEvent {
  if (isAiBusy(error)) return { type: "busy", message: AI_BUSY_MESSAGE };
  console.error("agent: run failed", error instanceof Error ? error.message : error);
  return { type: "error", message: "The agent hit a problem and stopped. Try again." };
}
