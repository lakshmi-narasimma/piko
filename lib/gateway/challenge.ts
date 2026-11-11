import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { challenges } from "../db/schema";
import { buildPaymentRequired, type PaymentRequired, type X402Config } from "../x402";
import type { GatewayRoute } from "./route";

/** Who a Challenge was issued to. Unknown (null) when the 402 went to a caller with no Key. */
export interface ChallengeBuyer {
  agentId: string;
  orgId: string;
}

export interface IssuedChallenge {
  nonce: string;
  paymentRequired: PaymentRequired;
}

/** How long an expired Challenge is kept, so a late payment still gets `challenge_expired`. */
export const EXPIRED_CHALLENGE_GRACE_SECONDS = 300;
/** The most expired Challenges one prune deletes, to keep each 402 cheap. */
export const PRUNE_BATCH_SIZE = 100;
/** The share of issued Challenges that also prune: enough to outpace any flood of 402s. */
const PRUNE_PROBABILITY = 0.1;

/**
 * Deletes up to `limit` Challenges that expired over the grace period ago and were never
 * reserved, and returns how many. Those can never be paid, and a Challenge is not a Ledger
 * entry, so deleting it loses no money history. One referenced by a Call or an Approval is
 * kept. Rows another prune is deleting are skipped rather than waited on.
 */
export async function pruneExpiredChallenges(db: Db, limit = PRUNE_BATCH_SIZE): Promise<number> {
  const { rowCount } = await db.execute(sql`
    delete from challenges
    where nonce in (
      select c.nonce from challenges c
      where c.reserved_at is null
        and c.expires_at < clock_timestamp() - make_interval(secs => ${EXPIRED_CHALLENGE_GRACE_SECONDS})
        and not exists (select 1 from calls where calls.nonce = c.nonce)
        and not exists (select 1 from approvals a where a.challenge_nonce = c.nonce)
      limit ${limit}
      for update skip locked
    )`);
  return rowCount ?? 0;
}

/**
 * Stores a Challenge for this route. The expiry comes from the database clock. Now and
 * then it also prunes old, unpaid Challenges, so anonymous 402s can't grow the table
 * without bound.
 */
export async function issueChallenge(
  db: Db,
  config: X402Config,
  route: GatewayRoute,
  buyer: ChallengeBuyer | null,
): Promise<IssuedChallenge> {
  if (Math.random() < PRUNE_PROBABILITY) {
    // Housekeeping must never cost the caller their 402.
    await pruneExpiredChallenges(db).catch((error: unknown) => {
      console.error("Pruning expired challenges failed", error);
    });
  }

  const nonce = `c_${randomBytes(16).toString("base64url")}`;
  const [row] = await db
    .insert(challenges)
    .values({
      nonce,
      endpointId: route.endpointId,
      agentId: buyer?.agentId,
      buyerOrgId: buyer?.orgId,
      amountMicro: route.priceMicro,
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${config.challengeTtlSeconds})`,
    })
    .returning({ expiresAt: challenges.expiresAt });

  return {
    nonce,
    paymentRequired: buildPaymentRequired(config, {
      sellerSlug: route.sellerSlug,
      path: route.path,
      listingName: route.listingName,
      listingDescription: route.listingDescription,
      nonce,
      amountMicro: route.priceMicro,
      expiresAt: row!.expiresAt,
    }),
  };
}
