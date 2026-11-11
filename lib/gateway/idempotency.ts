/**
 * `Idempotency-Key` for X-Piko-Autopay (docs/API.md section 2): a retry with the same key
 * reuses the same Challenge, so it can never pay twice.
 *
 * There is no idempotency table. The key picks the Challenge nonce, an HMAC of the agent,
 * the Endpoint and the key, so the Challenge row's state says how the first request went.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls } from "../db/schema";
import { jsonError } from "../http";
import type { AuthenticatedAgent } from "../keys";
import { loadChallenge, type PayableChallenge } from "../pay";
import type { X402Config } from "../x402";
import { issueChallenge } from "./challenge";
import type { GatewayRoute } from "./route";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const MAX_KEY_LENGTH = 255;
const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  // drizzle wraps driver errors, so look through `cause` for the Postgres error.
  for (let e = error; e instanceof Error; e = e.cause) {
    if ((e as Error & { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) return true;
  }
  return false;
}

/** The Challenge nonce one Idempotency-Key stands for. Unguessable without the secret. */
export function idempotentNonce(
  config: X402Config,
  agentId: string,
  endpointId: string,
  key: string,
): string {
  const mac = createHmac("sha256", config.receiptSigningSecret)
    .update(JSON.stringify(["idempotency", agentId, endpointId, key]))
    .digest("base64url");
  return `c_i_${mac.slice(0, 32)}`;
}

/**
 * The answer for a key whose Challenge was already paid, or is being paid right now, or
 * null if the request may go on and try to pay it.
 */
export async function idempotentReplay(db: Db, nonce: string): Promise<Response | null> {
  return replayOf(db, await loadChallenge(db, nonce));
}

async function replayOf(db: Db, challenge: PayableChallenge | undefined): Promise<Response | null> {
  if (!challenge) return null;
  const { nonce } = challenge;
  if (challenge.consumedAt) {
    const [call] = await db
      .select({ id: calls.id, upstreamStatus: calls.upstreamStatus })
      .from(calls)
      .where(eq(calls.nonce, nonce));
    return jsonError(
      409,
      "idempotent_replay",
      "A request with this Idempotency-Key was already paid. Nothing was charged again.",
      { callId: call?.id ?? null, upstreamStatus: call?.upstreamStatus ?? null },
    );
  }
  if (challenge.reservationActive) {
    return jsonError(
      409,
      "idempotency_in_progress",
      "A request with this Idempotency-Key is still being served.",
    );
  }
  return null;
}

export type IdempotentChallenge = { ok: true; nonce: string } | { ok: false; response: Response };

/**
 * Finds or issues the Challenge for this key. A key that was already paid, or is in flight,
 * gets its replay answer instead and nothing is charged.
 */
export async function idempotentChallenge(
  { db, config }: { db: Db; config: X402Config },
  route: GatewayRoute,
  buyer: AuthenticatedAgent,
  key: string,
): Promise<IdempotentChallenge> {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_request",
        `${IDEMPOTENCY_KEY_HEADER} must be 1 to ${MAX_KEY_LENGTH} characters.`,
      ),
    };
  }
  const nonce = idempotentNonce(config, buyer.agentId, route.endpointId, key);
  const existing = await loadChallenge(db, nonce);
  const replay = await replayOf(db, existing);
  if (replay) return { ok: false, response: replay };

  if (!existing) {
    try {
      await issueChallenge(db, config, route, buyer, { nonce });
    } catch (error) {
      // A concurrent request with the same key issued it first; paying sorts out who wins.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return { ok: true, nonce };
}
