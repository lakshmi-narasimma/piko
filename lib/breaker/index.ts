/**
 * Circuit breaker (docs/DESIGN.md section 9, step 2 of `POST /api/pay`). It freezes an
 * Agent that pays for more than `maxCalls` Calls inside a sliding `windowSeconds`, or more
 * than `maxMicroPerMinute` in the last minute, writes one alert and answers 429
 * `breaker_tripped`. From then on the Agent gets 423 `agent_frozen` until a human
 * unfreezes it.
 *
 * What counts: every payment this Agent reserved, read from `challenges.reserved_at`, so
 * the breaker needs no table of its own. A reservation counts from the moment it is taken,
 * whether the Call later settles, is released after an upstream failure or is never used:
 * the breaker limits attempts to pay, not successful Calls. A request stopped before the
 * funds step (by the breaker, a Policy, a Budget or low funds) reserves nothing and does
 * not count, and neither do free-allowance Calls, which never reach the pay pipeline.
 * Retrying the same nonce reuses its hold, so it counts once.
 *
 * Amounts are integer micro-USD throughout. Enforcement here is deterministic code only.
 */
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, alerts, challenges } from "../db/schema";
import { getEnv, type Env } from "../env";
import { releaseReservation } from "../ledger";
import { formatUsd, type MicroUsd } from "../money";

/** The alert type a trip writes. P5-08's alerts panel shows it. */
export const BREAKER_ALERT_TYPE = "breaker_tripped";

/** The spend limit's window. DESIGN.md section 9 states it per minute. */
const SPEND_WINDOW_SECONDS = 60;

// Time comes from the database, as in the Ledger, so the window never depends on the
// app server's clock.
const now = sql`clock_timestamp()`;

export interface BreakerLimits {
  /** Most Calls an Agent may pay for inside the window. The next one trips. */
  maxCalls: number;
  windowSeconds: number;
  /** Most micro-USD an Agent may reserve in any one minute. Going over trips. */
  maxMicroPerMinute: MicroUsd;
}

export function breakerLimitsFromEnv(env: Env = getEnv()): BreakerLimits {
  return {
    maxCalls: env.BREAKER_MAX_CALLS,
    windowSeconds: env.BREAKER_WINDOW_SECONDS,
    maxMicroPerMinute: env.BREAKER_MAX_MICRO_PER_MINUTE,
  };
}

/** Which limit a trip broke. */
export type BreakerReason = "calls" | "spend";

/** An Agent's recent payments, as the breaker counts them. */
export interface BreakerWindow {
  /** Reservations inside the sliding window. */
  calls: number;
  /** Micro-USD reserved in the last minute. */
  spentPerMinuteMicro: MicroUsd;
}

function describe(reason: BreakerReason, window: BreakerWindow, limits: BreakerLimits): string {
  return reason === "calls"
    ? `${window.calls} calls in ${limits.windowSeconds} s (limit ${limits.maxCalls})`
    : `${formatUsd(window.spentPerMinuteMicro)} in one minute (limit ${formatUsd(limits.maxMicroPerMinute)})`;
}

/**
 * Raised when an Agent goes over a limit. The pay pipeline answers it with 429
 * `breaker_tripped`. By then the Agent is frozen and the alert is written.
 */
export class BreakerTrippedError extends Error {
  constructor(
    public readonly reason: BreakerReason,
    public readonly window: BreakerWindow,
    public readonly limits: BreakerLimits,
  ) {
    super(`The circuit breaker froze this agent: ${describe(reason, window, limits)}.`);
    this.name = "BreakerTrippedError";
  }

  /** What went over, e.g. "51 calls in 10 s (limit 50)". */
  get summary(): string {
    return describe(this.reason, this.window, this.limits);
  }

  /** The error body's details (docs/API.md section 4). */
  get details() {
    return {
      reason: this.reason,
      calls: this.window.calls,
      windowSeconds: this.limits.windowSeconds,
      spentPerMinute: this.window.spentPerMinuteMicro.toString(),
    };
  }
}

/**
 * Counts an Agent's reservations in the window and in the last minute, optionally leaving
 * one Challenge out. Takes no locks.
 */
export async function readWindow(
  db: Db,
  input: { agentId: string; orgId: string; windowSeconds: number; excludeNonce?: string },
): Promise<BreakerWindow> {
  const { agentId, orgId, windowSeconds, excludeNonce } = input;
  const since = (seconds: number) => sql`${now} - make_interval(secs => ${seconds})`;
  const [row] = await db
    .select({
      calls: sql<string>`count(*) filter (where ${challenges.reservedAt} > ${since(windowSeconds)})`,
      spent: sql<string>`coalesce(sum(${challenges.amountMicro}) filter (where ${challenges.reservedAt} > ${since(SPEND_WINDOW_SECONDS)}), 0)`,
    })
    .from(challenges)
    .where(
      and(
        eq(challenges.agentId, agentId),
        // Redundant filters that let challenges_buyer_reservation_idx narrow the scan: an
        // Agent's holds are its org's, and a hold never ends before it starts, so one that
        // started inside the window also ends inside it or later.
        eq(challenges.buyerOrgId, orgId),
        gt(challenges.reservationExpiresAt, since(Math.max(windowSeconds, SPEND_WINDOW_SECONDS))),
        isNotNull(challenges.reservedAt),
        excludeNonce === undefined ? undefined : ne(challenges.nonce, excludeNonce),
      ),
    );
  return { calls: Number(row!.calls), spentPerMinuteMicro: BigInt(row!.spent) };
}

/** The limit this window breaks, or null when it is within both. */
export function brokenLimit(window: BreakerWindow, limits: BreakerLimits): BreakerReason | null {
  if (window.calls > limits.maxCalls) return "calls";
  if (window.spentPerMinuteMicro > limits.maxMicroPerMinute) return "spend";
  return null;
}

/**
 * Freezes the Agent and writes its alert, once. Returns false, writing nothing, when the
 * Agent is already frozen (a concurrent trip got there first, or a human froze it), so a
 * burst that trips many requests at once leaves exactly one alert.
 */
export function tripBreaker(db: Db, agentId: string, tripped: BreakerTrippedError) {
  return db.transaction(async (tx) => {
    const [frozen] = await tx
      .update(agents)
      .set({ frozenAt: sql`now()` })
      .where(and(eq(agents.id, agentId), isNull(agents.frozenAt)))
      .returning({ orgId: agents.orgId, name: agents.name });
    if (!frozen) return false;
    await tx.insert(alerts).values({
      orgId: frozen.orgId,
      agentId,
      type: BREAKER_ALERT_TYPE,
      message: `Circuit breaker froze ${frozen.name}: ${tripped.summary}.`,
    });
    return true;
  });
}

async function tripIfBroken(db: Db, agentId: string, window: BreakerWindow, limits: BreakerLimits) {
  const reason = brokenLimit(window, limits);
  if (!reason) return;
  const tripped = new BreakerTrippedError(reason, window, limits);
  await tripBreaker(db, agentId, tripped);
  throw tripped;
}

export interface BreakerPayment {
  agentId: string;
  orgId: string;
  nonce: string;
  amountMicro: MicroUsd;
}

/**
 * Step 2 of the pay pipeline: would paying this Challenge put the Agent over a limit?
 * Counts this payment as if it were reserved, so the Call over the limit is the one
 * that trips.
 *
 * Read without a lock, so a concurrent burst can pass it together; {@link confirmBreaker}
 * closes that gap after the reservation.
 *
 * @throws BreakerTrippedError after freezing the Agent.
 */
export async function checkBreaker(
  db: Db,
  payment: BreakerPayment,
  limits: BreakerLimits,
): Promise<void> {
  const { agentId, orgId, nonce, amountMicro } = payment;
  const others = await readWindow(db, {
    agentId,
    orgId,
    windowSeconds: limits.windowSeconds,
    excludeNonce: nonce,
  });
  await tripIfBroken(
    db,
    agentId,
    { calls: others.calls + 1, spentPerMinuteMicro: others.spentPerMinuteMicro + amountMicro },
    limits,
  );
}

/**
 * The race-safe half of the breaker, run right after this payment's reservation commits.
 * It counts again, now including this hold and every hold committed before it. A request
 * passes only if that count is within the limits, so among concurrent requests the last
 * one to pass sees every other one that passed: no burst can get more than `maxCalls`
 * through. Over the limit, it releases this hold (nothing was charged) and trips.
 *
 * This needs no lock: each count is a fresh READ COMMITTED snapshot taken after the
 * request's own reservation committed. It may stop every request of a burst that crosses
 * the limit together, which errs on the safe side.
 *
 * @throws BreakerTrippedError after releasing the hold and freezing the Agent.
 */
export async function confirmBreaker(
  db: Db,
  payment: Omit<BreakerPayment, "amountMicro">,
  limits: BreakerLimits,
): Promise<void> {
  const { agentId, orgId, nonce } = payment;
  const window = await readWindow(db, { agentId, orgId, windowSeconds: limits.windowSeconds });
  if (!brokenLimit(window, limits)) return;
  await releaseReservation(db, nonce);
  await tripIfBroken(db, agentId, window, limits);
}
