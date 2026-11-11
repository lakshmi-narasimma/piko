import type { LanguageModelV4 } from "@ai-sdk/provider";
import { AiBusy, AttemptTimeout, busyReason, type SkippedAttempt } from "./errors";

/** Where lib/llm reports which model answered and why it moved on. Never given prompts or keys. */
export interface LlmLogger {
  info(line: string): void;
  warn(line: string): void;
}

export const consoleLogger: LlmLogger = {
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
};

/** `provider:modelId`, with the SDK's provider name cut to its first part (`google.generative-ai` → `google`). */
export function modelLabel(model: { provider: string; modelId: string }): string {
  return `${model.provider.split(".")[0]}:${model.modelId}`;
}

/**
 * Runs one attempt with its own timeout, still honouring the caller's abort signal. The
 * timer stops once `run` resolves, so a stream that has started is not cut off.
 */
export async function withAttemptTimeout<T>(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const attempt = new AbortController();
  const timer = setTimeout(() => attempt.abort(new AttemptTimeout()), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, attempt.signal]) : attempt.signal;
  try {
    return await run(signal);
  } catch (error) {
    // The provider may wrap or replace our abort reason, so trust the signals instead.
    if (attempt.signal.aborted && !callerSignal?.aborted) throw new AttemptTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface FallbackOptions {
  /** Per-attempt limit. For streams it covers the wait for the response to start. */
  attemptTimeoutMs: number;
  logger: LlmLogger;
}

/**
 * One LanguageModelV4 that tries each model in `chain` in order. Because it sits below
 * generateText and streamText, the SDK's tools, multi-step loops, streaming and
 * structured output all work unchanged, and every step of a tool loop gets the fallback.
 *
 * It moves on only for errors that another model might not hit (see busyReason). Anything
 * else, including a schema mismatch (checked by the SDK above this layer), is rethrown
 * as is. When every model is skipped it throws AiBusy.
 *
 * It is sticky: once a model answers a step, later steps of the same call start from it,
 * so a tool loop doesn't pay a failed round trip to a rate-limited model on every step.
 * That makes it stateful, so build a fresh one per call (createLlm does).
 *
 * Streams fall back only until the response starts. An error event after that reaches
 * the caller as a stream error part, because text already sent can't be taken back.
 */
export function createFallbackModel(
  chain: readonly LanguageModelV4[],
  options: FallbackOptions,
): LanguageModelV4 {
  const first = chain[0];
  if (!first) throw new Error("lib/llm: the model chain is empty.");
  let start = 0;

  async function tryEach<T>(
    callerSignal: AbortSignal | undefined,
    call: (model: LanguageModelV4, signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    const skipped: SkippedAttempt[] = [];
    for (let index = start; index < chain.length; index++) {
      const model = chain[index]!;
      const label = modelLabel(model);
      try {
        const result = await withAttemptTimeout(callerSignal, options.attemptTimeoutMs, (signal) =>
          call(model, signal),
        );
        start = index;
        const after = skipped.length
          ? ` after skipping ${skipped.map((s) => `${s.model} (${describe(s)})`).join(", ")}`
          : "";
        options.logger.info(`llm: answered by ${label}${after}`);
        return result;
      } catch (error) {
        const busy = busyReason(error);
        if (!busy) throw error;
        skipped.push({ model: label, ...busy });
        const next = chain[index + 1];
        options.logger.warn(
          `llm: ${label} skipped (${describe(skipped.at(-1)!)}), ` +
            (next ? `trying ${modelLabel(next)}` : "no models left"),
        );
      }
    }
    throw new AiBusy(skipped);
  }

  return {
    specificationVersion: "v4",
    provider: "piko.fallback",
    modelId: chain.map((model) => model.modelId).join(" > "),
    // Empty, so the SDK downloads any file URLs itself instead of assuming every model
    // in the chain can fetch them.
    supportedUrls: {},
    doGenerate: (callOptions) =>
      tryEach(callOptions.abortSignal, (model, abortSignal) =>
        model.doGenerate({ ...callOptions, abortSignal }),
      ),
    doStream: (callOptions) =>
      tryEach(callOptions.abortSignal, (model, abortSignal) =>
        model.doStream({ ...callOptions, abortSignal }),
      ),
  };
}

function describe(attempt: SkippedAttempt): string {
  return attempt.status ? `${attempt.reason}, HTTP ${attempt.status}` : attempt.reason;
}
