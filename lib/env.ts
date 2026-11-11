import { z } from "zod";

/**
 * Server-side environment, validated once with zod.
 *
 * Every variable is listed in .env.example. Empty strings count as missing, so a
 * required variable left blank fails just like an absent one, and a variable with a
 * default falls back to that default. Never import this from client components:
 * it reads secrets.
 */

const required = z.string().min(1);
const positiveInt = z.coerce.number().int().positive();

// Decision 0011: aliases such as gemini-flash-latest hot-swap without notice, so only
// pinned ids are accepted.
const pinnedModelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]*$/i, "must be a model id")
  .refine((id) => !id.endsWith("-latest"), "must be a pinned model id, not a -latest alias");

function commaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // App
  APP_BASE_URL: z.url(),
  SESSION_SECRET: required,
  RECEIPT_SIGNING_SECRET: required,
  DEMO_MODE: z.stringbool().default(false),

  // Database (Neon). The app uses the pooled URL; migrations use the direct one.
  DATABASE_URL: z.url(),
  DATABASE_URL_POOLED: z.url(),

  // PayPal (sandbox)
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: required,
  PAYPAL_CLIENT_SECRET: required,
  // Known only after the webhook is registered on the deployed app.
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: required,
  PAYPAL_DEMO_SHOP_EMAIL: z.email(),

  // AI (see docs/decisions/0011). lib/llm tries GEMINI_MODEL, then each fallback in order,
  // then Groq when GROQ_API_KEY is set.
  GEMINI_API_KEY: required,
  GEMINI_MODEL: pinnedModelId.default("gemini-3.6-flash"),
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default("gemini-3-flash-preview,gemini-3.5-flash-lite")
    .transform(commaList)
    .pipe(z.array(pinnedModelId)),
  // Changing either of these means re-embedding every listing: vectors from different
  // models or sizes are not comparable.
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-2"),
  GEMINI_EMBEDDING_DIMENSIONS: positiveInt.max(3072).default(768),
  // Optional last fallback. Empty means the chain is Gemini only.
  GROQ_API_KEY: z.string().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),

  // Sponsor APIs. Optional until the Product Search sample API uses it.
  CHANNEL3_API_KEY: z.string().default(""),

  // Business rules
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
  // Integer micro-USD, kept as bigint (see docs/decisions/0009).
  PAYOUT_THRESHOLD_MICRO: z
    .string()
    .regex(/^\d+$/, "must be a whole number of micro-USD")
    .default("1000000")
    .transform((value) => BigInt(value)),
  BREAKER_MAX_CALLS: positiveInt.default(50),
  BREAKER_WINDOW_SECONDS: positiveInt.default(10),
  CHALLENGE_TTL_SECONDS: positiveInt.default(30),
  RECEIPT_TTL_SECONDS: positiveInt.default(60),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(10_000),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment (see .env.example):\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "EnvError";
  }
}

/** Validates an env source. Throws EnvError naming each bad variable, never its value. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => {
        // The variable is the first path segment; list items add an index after it.
        const name = String(issue.path[0]);
        return name in present ? `${name}: ${issue.message}` : `${name}: missing`;
      }),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** The validated process environment. Validates on first use and caches the result. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
