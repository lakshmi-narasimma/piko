import { APICallError } from "ai";

/**
 * Why a model was skipped. Each of these can clear up on a different model or provider,
 * because Gemini quotas are per project and per model, and Groq is a separate service.
 */
export type BusyReason =
  /** 429 / RESOURCE_EXHAUSTED: this model's quota is used up for now. */
  | "rate_limited"
  /** 503 UNAVAILABLE "high demand", or Groq's 498 flex capacity exceeded. */
  | "overloaded"
  /** 500, 502, 504. Google treats 5xx as transient and suggests switching model on 500. */
  | "server_error"
  /** 408, or the attempt ran past lib/llm's per-attempt timeout. */
  | "timeout"
  /** The request never got an HTTP response (DNS, reset connection, fetch failed). */
  | "unreachable"
  /** 404: the model id is retired or unknown. Previews can be shut down at short notice (0011). */
  | "model_unavailable";

/** One model in the chain that was tried and skipped. Holds no prompt, key or provider text. */
export interface SkippedAttempt {
  /** `provider:modelId`, e.g. `google:gemini-3.6-flash`. */
  model: string;
  reason: BusyReason;
  /** The provider's HTTP status, when there was one. */
  status?: number;
}

/** Shown to the user as is. It names no model, prompt or key. */
export const AI_BUSY_MESSAGE = "The AI is busy right now. Please try again in a minute.";

/**
 * Every model in the chain was rate-limited, overloaded or unavailable. The UI shows
 * `message` (the "AI busy" fallback in TEST_PLAN F9). Branch on `code`, not on the class,
 * so the check also works across bundles. It deliberately has no `cause`: the SDK's
 * APICallError carries the request body, which includes the prompt.
 */
export class AiBusy extends Error {
  readonly code = "ai_busy";
  /** The `provider:modelId` of each model tried, in order. */
  readonly modelsTried: readonly string[];

  constructor(readonly attempts: readonly SkippedAttempt[]) {
    super(AI_BUSY_MESSAGE);
    this.name = "AiBusy";
    this.modelsTried = attempts.map((attempt) => attempt.model);
  }
}

export function isAiBusy(error: unknown): error is AiBusy {
  return (
    error instanceof Error &&
    error.name === "AiBusy" &&
    (error as { code?: unknown }).code === "ai_busy"
  );
}

/** Thrown inside an attempt when lib/llm's own per-attempt timer fires. */
export class AttemptTimeout extends Error {
  constructor() {
    super("The model did not answer within the attempt timeout.");
    this.name = "AttemptTimeout";
  }
}

/**
 * Whether trying the next model could help, and why. Returns null for errors another
 * model would hit too: bad requests (400), auth or permission (401, 403), our own bugs,
 * schema validation failures and aborts by the caller. Those are rethrown unchanged.
 */
export function busyReason(error: unknown): { reason: BusyReason; status?: number } | null {
  if (error instanceof AttemptTimeout) return { reason: "timeout" };
  if (!APICallError.isInstance(error)) return null;

  const status = error.statusCode;
  if (status === undefined) {
    // The SDK marks a failed fetch (no response at all) as retryable.
    return error.isRetryable ? { reason: "unreachable" } : null;
  }
  if (status === 429) return { reason: "rate_limited", status };
  if (status === 503 || status === 498) return { reason: "overloaded", status };
  if (status === 500 || status === 502 || status === 504) return { reason: "server_error", status };
  if (status === 408) return { reason: "timeout", status };
  if (status === 404) return { reason: "model_unavailable", status };
  return null;
}
