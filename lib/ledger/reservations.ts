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
}

export interface Reservation {
  nonce: string;
  agentId: string;
  buyerOrgId: string;
  amountMicro: bigint;
  reservationExpiresAt: Date;
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
 * @throws InsufficientFundsError when the org can't cover the amount.
 * @throws LedgerError `org_not_found`, `invalid_amount`, `challenge_not_found`,
 *   `challenge_consumed`, `challenge_expired`, `challenge_already_reserved` or
 *   `unsupported_isolation`.
 */
export function reserveFunds(db: DbOrTx, input: ReserveFundsInput): Promise<Reservation> {
  const { nonce, agentId, buyerOrgId, ttlSeconds } = input;
  return db.transaction(async (tx) => {
    await assertReadCommitted(tx);
    const org = await lockOrg(tx, buyerOrgId);

    const [challenge] = await lockChallenge(tx, nonce);
    if (!challenge) throw challengeNotFound(nonce);
    if (challenge.consumedAt) throw challengeConsumed(nonce);
    if (challenge.expired) {
      throw new LedgerError("challenge_expired", `Challenge ${nonce} has expired.`);
    }
    if (challenge.reservationActive) {
      throw new LedgerError(
        "challenge_already_reserved",
        `Challenge ${nonce} already holds a reservation.`,
      );
    }
    if (challenge.amountMicro <= 0n) {
      throw new LedgerError("invalid_amount", "A reservation must have a positive amount.");
    }

    const available = await fundsOf(tx, org);
    if (available < challenge.amountMicro) {
      throw new InsufficientFundsError(challenge.amountMicro, available);
    }

    const [reserved] = await tx
      .update(challenges)
      .set({
        agentId,
        buyerOrgId,
        reservedAt: now,
        reservationExpiresAt: sql`${now} + make_interval(secs => ${ttlSeconds})`,
      })
      .where(eq(challenges.nonce, nonce))
      .returning({ reservationExpiresAt: challenges.reservationExpiresAt });

    return {
      nonce,
      agentId,
      buyerOrgId,
      amountMicro: challenge.amountMicro,
      reservationExpiresAt: reserved!.reservationExpiresAt!,
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
 */
export async function releaseReservation(db: DbOrTx, nonce: string): Promise<void> {
  await db
    .update(challenges)
    .set({
      reservationExpiresAt: sql`least(${challenges.reservationExpiresAt}, ${now})`,
      expiresAt: sql`least(${challenges.expiresAt}, ${now})`,
    })
    .where(and(eq(challenges.nonce, nonce), isNull(challenges.consumedAt)));
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
