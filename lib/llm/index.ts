import { createGoogle } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { EmbeddingModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import type { Context, FetchFunction } from "@ai-sdk/provider-utils";
import {
  embed as sdkEmbed,
  embedMany as sdkEmbedMany,
  generateText as sdkGenerateText,
  Output,
  streamText as sdkStreamText,
  type FlexibleSchema,
  type GenerateTextResult,
  type InferSchema,
  type ModelMessage,
  type OutputInterface,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { getEnv, type Env } from "../env";
import { AiBusy, busyReason } from "./errors";
import {
  consoleLogger,
  createFallbackModel,
  modelLabel,
  withAttemptTimeout,
  type LlmLogger,
} from "./fallback";

/**
 * The only way into a model provider. Every AI feature (review summariser, directory
 * embeddings, the playground agent, the policy compiler, the pricing assistant) goes
 * through here, so the fallback chain and the "AI busy" error behave the same everywhere.
 *
 * Gemini only drafts and assists. Nothing here decides or moves money: Budgets, Policies
 * and the circuit breaker are deterministic code in lib/policy and lib/breaker.
 */

export { AI_BUSY_MESSAGE, AiBusy, isAiBusy } from "./errors";
export type { BusyReason, SkippedAttempt } from "./errors";
export type { LlmLogger } from "./fallback";

/**
 * Each attempt gets this long before lib/llm moves to the next model. Gemini 3.6 Flash
 * answered in 1.5–3.7 s and 3.5 Flash-Lite in 6–17 s in the 0011 tests, so 20 s leaves
 * room for a slow but healthy answer. For streams it bounds the wait for the first byte.
 * Bound a whole call with the SDK's `timeout` or `abortSignal`; neither causes a fallback.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;

export interface LlmConfig {
  geminiApiKey: string;
  geminiModel: string;
  geminiFallbackModels: readonly string[];
  embeddingModel: string;
  embeddingDimensions: number;
  /** Empty means no Groq fallback. */
  groqApiKey: string;
  groqModel: string;
}

export function llmConfigFromEnv(env: Env = getEnv()): LlmConfig {
  return {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    geminiFallbackModels: env.GEMINI_FALLBACK_MODELS,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL,
    embeddingDimensions: env.GEMINI_EMBEDDING_DIMENSIONS,
    groqApiKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL,
  };
}

/** The models lib/llm uses. Tests pass mocks from `ai/test` here instead of mocking modules. */
export interface LlmModels {
  /** Tried in order for text and structured output. */
  chain: readonly LanguageModelV4[];
  /** One model only, so every stored vector stays in the same space. */
  embedding: EmbeddingModelV4;
  embeddingDimensions: number;
}

/**
 * Builds the real chain: GEMINI_MODEL, then each GEMINI_FALLBACK_MODELS entry in order,
 * then GROQ_MODEL if GROQ_API_KEY is set. `fetch` is for tests and the smoke test, to
 * force a provider failure without a network.
 */
export function modelsFromConfig(config: LlmConfig, fetch?: FetchFunction): LlmModels {
  const google = createGoogle({ apiKey: config.geminiApiKey, fetch });
  const geminiIds = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  const chain: LanguageModelV4[] = geminiIds.map((id) => google(id));
  if (config.groqApiKey) {
    chain.push(createGroq({ apiKey: config.groqApiKey, fetch })(config.groqModel));
  }
  return {
    chain,
    embedding: google.embedding(config.embeddingModel),
    embeddingDimensions: config.embeddingDimensions,
  };
}

export interface LlmOptions {
  attemptTimeoutMs?: number;
  logger?: LlmLogger;
}

// The SDK's own option types, minus what lib/llm controls. `model` is the fallback chain,
// and `maxRetries` is always 0: the SDK would otherwise retry the whole chain with 2 s and
// 4 s backoffs, which makes the order unpredictable and leaves a judge waiting.
type Controlled = "model" | "maxRetries";
// The SDK's prompt type is a union (`prompt` or `messages`), which a plain Omit would merge.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
// Restated so TypeScript infers TOOLS, CTX and OUTPUT straight from the call, as the SDK does.
type Inferable<TOOLS, CTX, OUTPUT> = { tools?: TOOLS; runtimeContext?: CTX; output?: OUTPUT };
type SdkGenerateTextOptions<
  TOOLS extends ToolSet,
  CTX extends Context,
  OUTPUT extends OutputInterface,
> = Parameters<typeof sdkGenerateText<TOOLS, CTX, OUTPUT>>[0];
type SdkStreamTextOptions<
  TOOLS extends ToolSet,
  CTX extends Context,
  OUTPUT extends OutputInterface,
> = Parameters<typeof sdkStreamText<TOOLS, CTX, OUTPUT>>[0];

export type GenerateTextOptions<
  TOOLS extends ToolSet = ToolSet,
  CTX extends Context = Context,
  OUTPUT extends OutputInterface = OutputInterface<string, string>,
> = DistributiveOmit<SdkGenerateTextOptions<TOOLS, CTX, OUTPUT>, Controlled> &
  Inferable<TOOLS, CTX, OUTPUT>;
export type StreamTextOptions<
  TOOLS extends ToolSet = ToolSet,
  CTX extends Context = Context,
  OUTPUT extends OutputInterface = OutputInterface<string, string, never>,
> = DistributiveOmit<SdkStreamTextOptions<TOOLS, CTX, OUTPUT>, Controlled> &
  Inferable<TOOLS, CTX, OUTPUT>;

/** A prompt for generateStructured: either `prompt` or `messages`, as in the SDK. */
export type StructuredPrompt = { instructions?: string; abortSignal?: AbortSignal } & (
  { prompt: string; messages?: never } | { messages: ModelMessage[]; prompt?: never }
);

export interface Llm {
  /**
   * Text generation with the fallback chain. Takes every generateText option except
   * `model` and `maxRetries`, so tools, `stopWhen` and `output` work as in the SDK docs.
   * Throws AiBusy when every model is busy; other errors are the SDK's own.
   */
  generateText<
    TOOLS extends ToolSet = ToolSet,
    CTX extends Context = Context,
    OUTPUT extends OutputInterface = OutputInterface<string, string>,
  >(
    options: GenerateTextOptions<TOOLS, CTX, OUTPUT>,
  ): Promise<GenerateTextResult<TOOLS, CTX, OUTPUT>>;

  /**
   * Streaming with the fallback chain, for the playground agent. AiBusy and other errors
   * arrive as an `error` part on `result.stream` (and in `onError`), as the SDK does.
   */
  streamText<
    TOOLS extends ToolSet = ToolSet,
    CTX extends Context = Context,
    OUTPUT extends OutputInterface = OutputInterface<string, string, never>,
  >(
    options: StreamTextOptions<TOOLS, CTX, OUTPUT>,
  ): StreamTextResult<TOOLS, CTX, OUTPUT>;

  /**
   * Structured output, validated against `schema` (zod works). A reply that doesn't match
   * throws the SDK's NoObjectGeneratedError and is never treated as busy: the next model
   * would get the same prompt and the same schema.
   */
  generateStructured<SCHEMA extends FlexibleSchema>(
    options: StructuredPrompt & { schema: SCHEMA; name?: string; description?: string },
  ): Promise<InferSchema<SCHEMA>>;

  /** One embedding at the configured dimensions. Throws AiBusy if the model is busy. */
  embed(value: string, options?: { abortSignal?: AbortSignal }): Promise<number[]>;

  /** Many embeddings, in the same order as `values`. */
  embedMany(values: string[], options?: { abortSignal?: AbortSignal }): Promise<number[][]>;

  /**
   * A fresh fallback model, for SDK helpers lib/llm doesn't wrap (e.g. ToolLoopAgent).
   * Pass `maxRetries: 0` alongside it. Use one per call: it remembers which model answered.
   */
  languageModel(): LanguageModelV4;
}

export function createLlm(models: LlmModels, options: LlmOptions = {}): Llm {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const logger = options.logger ?? consoleLogger;
  const languageModel = () => createFallbackModel(models.chain, { attemptTimeoutMs, logger });
  const embeddingLabel = modelLabel(models.embedding);

  /**
   * Embeddings have no fallback. Groq has no embedding model, and a different Gemini
   * embedding model (or size) would put vectors in another space, so search results
   * would silently go wrong. A busy model therefore ends straight in AiBusy.
   */
  async function embedding<T>(
    abortSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await withAttemptTimeout(abortSignal, attemptTimeoutMs, run);
      logger.info(`llm: embedded with ${embeddingLabel}`);
      return result;
    } catch (error) {
      const busy = busyReason(error);
      if (!busy) throw error;
      logger.warn(`llm: ${embeddingLabel} skipped (${busy.reason}), no embedding fallback`);
      throw new AiBusy([{ model: embeddingLabel, ...busy }]);
    }
  }

  function checkDimensions(vector: number[]): number[] {
    // A wrong size would fail on insert into vector(N), or worse, compare as garbage.
    if (vector.length !== models.embeddingDimensions) {
      throw new Error(
        `lib/llm: ${embeddingLabel} returned ${vector.length} dimensions, expected ${models.embeddingDimensions}.`,
      );
    }
    return vector;
  }

  // The casts only restore what the Omit took out: the object is the caller's SDK options
  // plus `model` and `maxRetries`. TypeScript can't prove that through the SDK's
  // conditional option types.
  function generateText<
    TOOLS extends ToolSet,
    CTX extends Context,
    OUTPUT extends OutputInterface = OutputInterface<string, string>,
  >(callOptions: GenerateTextOptions<TOOLS, CTX, OUTPUT>) {
    return sdkGenerateText<TOOLS, CTX, OUTPUT>({
      ...callOptions,
      model: languageModel(),
      maxRetries: 0,
    } as unknown as SdkGenerateTextOptions<TOOLS, CTX, OUTPUT>);
  }

  function streamText<
    TOOLS extends ToolSet,
    CTX extends Context,
    OUTPUT extends OutputInterface = OutputInterface<string, string, never>,
  >(callOptions: StreamTextOptions<TOOLS, CTX, OUTPUT>) {
    return sdkStreamText<TOOLS, CTX, OUTPUT>({
      ...callOptions,
      model: languageModel(),
      maxRetries: 0,
    } as unknown as SdkStreamTextOptions<TOOLS, CTX, OUTPUT>);
  }

  return {
    generateText,
    streamText,

    async generateStructured({ schema, name, description, ...prompt }) {
      const result = await sdkGenerateText({
        ...prompt,
        model: languageModel(),
        maxRetries: 0,
        output: Output.object({ schema, name, description }),
      });
      return result.output as InferSchema<typeof schema>;
    },

    embed: (value, callOptions = {}) =>
      embedding(callOptions.abortSignal, async (abortSignal) => {
        const { embedding: vector } = await sdkEmbed({
          model: models.embedding,
          value,
          dimensions: models.embeddingDimensions,
          maxRetries: 0,
          abortSignal,
        });
        return checkDimensions(vector);
      }),

    embedMany: (values, callOptions = {}) =>
      embedding(callOptions.abortSignal, async (abortSignal) => {
        const { embeddings } = await sdkEmbedMany({
          model: models.embedding,
          values,
          dimensions: models.embeddingDimensions,
          maxRetries: 0,
          abortSignal,
        });
        return embeddings.map(checkDimensions);
      }),

    languageModel,
  };
}

let cached: Llm | undefined;

/** The app's Llm, built from the validated environment on first use. */
export function getLlm(): Llm {
  cached ??= createLlm(modelsFromConfig(llmConfigFromEnv()));
  return cached;
}
