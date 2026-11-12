import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { challenges, endpoints, listings, orgs } from "../db/schema";
import { balanceOf, postCall, type DbOrTx, type PostedCall, type Tx } from "./entries";
import { InsufficientFundsError, LedgerError } from "./errors";

// Time comes from the database, so expiry never depends on the app server's clock.
const now = sql`clock_timestamp()`;

type OrgFunds = Pick<typeof orgs.$inferSelect, "id" | "billing" | "creditLimitMicro">;

export interface ReserveFundsInput {
  nonce: string;
  agentId: string;
  buyerOrgId: string;
  /** How long the reservation holds funds. Use the Receipt's lifetime. */
  ttlSeconds: number;
  /**
   * Runs under the buyer org's lock, just before the funds check, for a new hold only (not
   * for a reissued one). Throw to refuse the hold. It sees every other hold of the org that
   * committed first, so a limit it checks (a Budget) can't be overrun by concurrent payments.
   */
  beforeHold?: (tx: DbOrTx, hold: { amountMicro: bigint; endpointId: string }) => Promise<void>;
}

export interface Reservation {
  nonce: string;
  agentId: string;
  buyerOrgId: string;
  amountMicro: bigint;
  reservationExpiresAt: Date;
  /**
   * True when this agent already held this Challenge and nothing has used the hold yet:
   * the existing hold is returned unchanged, so a retried payment gets the same Receipt.
   */
  reissued: boolean;
}

export interface SettledCall extends PostedCall {
  nonce: string;
  agentId: string;
  endpointId: string;
}

/**
 * The org lock only protects a funds check that reads after the lock is granted. Under
 * READ COMMITTED each statement takes a fresh snapshot, so it sees what the previous
 * lock holder committed. Under REPEATABLE READ or SERIALIZABLE the snapshot can predate
 * that commit, so two reservations would both see the same funds and overdraw the
 * wallet. Refuse to run there rather than check funds against a stale snapshot.
 */
async function assertReadCommitted(tx: Tx) {
  const { rows } = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  const level = rows[0]?.level;
  if (level !== "read committed") {
    throw new LedgerError(
      "unsupported_isolation",
      `Ledger reservations need READ COMMITTED isolation, but this transaction is ${level}.`,
    );
  }
}

/**
 * Serialises everything that moves an org's available funds.
 *
 * FOR NO KEY UPDATE rather than FOR UPDATE: it excludes other reservers just the same,
 * but lets foreign-key checks through. With FOR UPDATE, two orgs buying from each other
 * deadlock, because each ledger insert needs a key-share lock on the other's row.
 */
async function lockOrg(tx: Tx, orgId: string) {
  const [org] = await tx.select().from(orgs).where(eq(orgs.id, orgId)).for("no key update");
  if (!org) throw new LedgerError("org_not_found", `Org ${orgId} does not exist.`);
  return org;
}

function lockChallenge(tx: Tx, nonce: string) {
  return tx
    .select({
      amountMicro: challenges.amountMicro,
      agentId: challenges.agentId,
      buyerOrgId: challenges.buyerOrgId,
      endpointId: challenges.endpointId,
      consumedAt: challenges.consumedAt,
      expired: sql<boolean>`${challenges.expiresAt} <= ${now}`,
      reservationActive: sql<boolean>`coalesce(${challenges.reservedAt} is not null and ${challenges.reservationExpiresAt} > ${now}, false)`,
    })
    .from(challenges)
    .where(eq(challenges.nonce, nonce))
    .for("no key update");
}

const challengeNotFound = (nonce: string) =>
  new LedgerError("challenge_not_found", `Challenge ${nonce} does not exist.`);
const challengeConsumed = (nonce: string) =>
  new LedgerError("challenge_consumed", `Challenge ${nonce} is already used.`);

async function fundsOf(db: DbOrTx, org: OrgFunds): Promise<bigint> {
  const balance = await balanceOf(db, { type: "wallet", orgId: org.id });
  const [held] = await db
    .select({ total: sql<string>`coalesce(sum(${challenges.amountMicro}), 0)` })
    .from(challenges)
    .where(
      and(
        eq(challenges.buyerOrgId, org.id),
        isNotNull(challenges.reservedAt),
        isNull(challenges.consumedAt),
        gt(challenges.reservationExpiresAt, now),
      ),
    );
  const credit = org.billing === "invoiced" ? org.creditLimitMicro : 0n;
  return credit + balance - BigInt(held!.total);
}

/**
 * What an org can spend: wallet balance minus active reservations, plus the credit
 * limit if it is invoiced. Advisory outside a lock; reserveFunds is what enforces it.
 *
 * @throws LedgerError `org_not_found`.
 */
export async function availableFunds(db: DbOrTx, orgId: string): Promise<bigint> {
  const [org] = await db
    .select({ id: orgs.id, billing: orgs.billing, creditLimitMicro: orgs.creditLimitMicro })
    .from(orgs)
    .where(eq(orgs.id, orgId));
  if (!org) throw new LedgerError("org_not_found", `Org ${orgId} does not exist.`);
  return fundsOf(db, org);
}

/**
 * Holds a Challenge's amount against the buyer. Concurrent reservations for one org
 * queue on its row, so together they can't overdraw it. The hold lives on the Challenge
 * and writes no Ledger entry (DESIGN.md section 12). It must run at READ COMMITTED, the
 * Postgres default: inside a caller's REPEATABLE READ or SERIALIZABLE transaction it
 * throws, because that snapshot could hide a concurrent reservation.
 *
 * A Challenge bound to a buyer org (issued with a Key, or reserved before) can only be
 * reserved by that org; the check runs under the Challenge lock, so every caller gets it.
 * Reserving again during an active hold that the same agent took, and that nothing has
 * claimed yet, returns that hold unchanged (`reissued: true`) instead of failing, so a
 * retried payment is safe. A hold is unclaimed while it still ends exactly `ttlSeconds`
 * after it started: claiming it for a Call moves its expiry.
 *
 * @throws InsufficientFundsError when the org can't cover the amount.
 * @throws LedgerError `org_not_found`, `invalid_amount`, `challenge_not_found`,
 *   `challenge_buyer_mismatch`, `challenge_consumed`, `challenge_expired`,
 *   `challenge_already_reserved` or `unsupported_isolation`.
 */
export function reserveFunds(db: DbOrTx, input: ReserveFundsInput): Promise<Reservation> {
  const { nonce, agentId, buyerOrgId, ttlSeconds, beforeHold } = input;
  return db.transaction(async (tx) => {
    await assertReadCommitted(tx);
    const org = await lockOrg(tx, buyerOrgId);

    const [challenge] = await lockChallenge(tx, nonce);
    if (!challenge) throw challengeNotFound(nonce);
    if (challenge.buyerOrgId && challenge.buyerOrgId !== buyerOrgId) {
      throw new LedgerError(
        "challenge_buyer_mismatch",
        `Challenge ${nonce} belongs to a different buyer.`,
      );
    }
    if (challenge.consumedAt) throw challengeConsumed(nonce);
    // Before the expiry check: a hold outlives its Challenge's expiry, and a retry during it
    // must still get its Receipt back.
    if (challenge.reservationActive) {
      const [hold] = await tx
        .select({
          reservationExpiresAt: challenges.reservationExpiresAt,
          unclaimed: sql<boolean>`${challenges.reservationExpiresAt} = ${challenges.reservedAt} + make_interval(secs => ${ttlSeconds})`,
        })
        .from(challenges)
        .where(eq(challenges.nonce, nonce));
      if (challenge.agentId === agentId && hold!.unclaimed) {
        return {
          nonce,
          agentId,
          buyerOrgId,
          amountMicro: challenge.amountMicro,
          reservationExpiresAt: hold!.reservationExpiresAt!,
          reissued: true,
        };
      }
      throw new LedgerError(
        "challenge_already_reserved",
        `Challenge ${nonce} already holds a reservation.`,
      );
    }
    if (challenge.expired) {
      throw new LedgerError("challenge_expired", `Challenge ${nonce} has expired.`);
    }
    if (challenge.amountMicro <= 0n) {
      throw new LedgerError("invalid_amount", "A reservation must have a positive amount.");
    }

    await beforeHold?.(tx, {
      amountMicro: challenge.amountMicro,
      endpointId: challenge.endpointId,
    });

    const available = await fundsOf(tx, org);
    if (available < challenge.amountMicro) {
      throw new InsufficientFundsError(challenge.amountMicro, available);
    }

    // Both from one instant, so an unclaimed hold ends exactly ttlSeconds after it started.
    const reservedAt = sql`statement_timestamp()`;
    const [reserved] = await tx
      .update(challenges)
      .set({
        agentId,
        buyerOrgId,
        reservedAt,
        reservationExpiresAt: sql`${reservedAt} + make_interval(secs => ${ttlSeconds})`,
      })
      .where(eq(challenges.nonce, nonce))
      .returning({ reservationExpiresAt: challenges.reservationExpiresAt });

    return {
      nonce,
      agentId,
      buyerOrgId,
      amountMicro: challenge.amountMicro,
      reservationExpiresAt: reserved!.reservationExpiresAt!,
      reissued: false,
    };
  });
}

export interface ClaimReservationInput {
  nonce: string;
  agentId: string;
  buyerOrgId: string;
  /** The Receipt's `exp` claim, in seconds since the epoch. */
  receiptExp: number;
  /** How long the hold must last from now: long enough to read, forward and settle. */
  holdSeconds: number;
}

/**
 * Starts serving a Receipt: the one atomic step that lets a single request through to the
 * seller, across processes. Returns false if the hold has ended, belongs to another
 * Receipt, or is already being served.
 *
 * A Receipt's `exp` is its hold's expiry rounded down to a second, so a hold whose expiry
 * is in [exp, exp + 1s) is the one that Receipt was issued for. Claiming moves the expiry
 * to at least exp + 1s, and to at least `holdSeconds` from now, so the hold covers the whole
 * upstream call and the same Receipt can't be claimed twice. A Receipt from an earlier hold
 * on the same Challenge never matches a later one.
 */
export async function claimReservation(db: DbOrTx, input: ClaimReservationInput): Promise<boolean> {
  const { nonce, agentId, buyerOrgId, receiptExp, holdSeconds } = input;
  const issuedUntil = sql`to_timestamp(${receiptExp + 1})`;
  const claimed = await db
    .update(challenges)
    .set({
      reservationExpiresAt: sql`greatest(${now} + make_interval(secs => ${holdSeconds}), ${issuedUntil})`,
    })
    .where(
      and(
        eq(challenges.nonce, nonce),
        eq(challenges.agentId, agentId),
        eq(challenges.buyerOrgId, buyerOrgId),
        isNotNull(challenges.reservedAt),
        isNull(challenges.consumedAt),
        gt(challenges.reservationExpiresAt, now),
        sql`${challenges.reservationExpiresAt} < ${issuedUntil}`,
      ),
    )
    .returning({ nonce: challenges.nonce });
  return claimed.length > 0;
}

/**
 * Ends a Challenge's hold early, for a Call that failed before settling: nothing was
 * charged, so nothing needs reversing. Writes no Ledger entry. The Challenge expires too,
 * so it can't be paid again and its Receipt can never become valid again; the agent asks
 * for a new 402.
 *
 * Returns false when the Challenge is unknown or was already settled. It returns true
 * for any unsettled Challenge, including one that was already released (the update is
 * a no-op then), so callers that must act once rely on a unique key, as refundPayment
 * does with calls.nonce.
 */
export async function releaseReservation(db: DbOrTx, nonce: string): Promise<boolean> {
  const released = await db
    .update(challenges)
    .set({
      reservationExpiresAt: sql`least(${challenges.reservationExpiresAt}, ${now})`,
      expiresAt: sql`least(${challenges.expiresAt}, ${now})`,
    })
    .where(and(eq(challenges.nonce, nonce), isNull(challenges.consumedAt)))
    .returning({ nonce: challenges.nonce });
  return released.length > 0;
}

/**
 * Consumes a Challenge's reservation and posts its Call, atomically. The seller comes
 * from the Challenge's endpoint and the price from its amount, so a caller can't
 * misdirect the money. Like reserveFunds, it must run at READ COMMITTED.
 *
 * @throws LedgerError `challenge_not_found`, `challenge_consumed`,
 *   `reservation_not_active` (never reserved, or the hold expired),
 *   `call_already_posted` or `unsupported_isolation`.
 */
export function settleCall(
  db: DbOrTx,
  input: { nonce: string; callId: string },
): Promise<SettledCall> {
  const { nonce, callId } = input;
  return db.transaction(async (tx) => {
    const notActive = new LedgerError(
      "reservation_not_active",
      `Challenge ${nonce} has no active reservation.`,
    );

    await assertReadCommitted(tx);

    // Take the org lock before the Challenge lock, in the same order as reserveFunds.
    const [peek] = await tx
      .select({ buyerOrgId: challenges.buyerOrgId })
      .from(challenges)
      .where(eq(challenges.nonce, nonce));
    if (!peek) throw challengeNotFound(nonce);
    if (!peek.buyerOrgId) throw notActive;
    await lockOrg(tx, peek.buyerOrgId);

    const [challenge] = await lockChallenge(tx, nonce);
    if (!challenge) throw challengeNotFound(nonce);
    if (challenge.consumedAt) throw challengeConsumed(nonce);
    if (
      !challenge.reservationActive ||
      !challenge.agentId ||
      challenge.buyerOrgId !== peek.buyerOrgId
    ) {
      throw notActive;
    }

    const [seller] = await tx
      .select({ orgId: listings.sellerOrgId })
      .from(endpoints)
      .innerJoin(listings, eq(endpoints.listingId, listings.id))
      .where(eq(endpoints.id, challenge.endpointId));

    await tx.update(challenges).set({ consumedAt: now }).where(eq(challenges.nonce, nonce));
    const posted = await postCall(tx, {
      callId,
      buyerOrgId: peek.buyerOrgId,
      sellerOrgId: seller!.orgId,
      priceMicro: challenge.amountMicro,
    });

    return { ...posted, nonce, agentId: challenge.agentId, endpointId: challenge.endpointId };
  });
}
