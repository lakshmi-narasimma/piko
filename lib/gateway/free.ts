import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls } from "../db/schema";
import type { GatewayRoute } from "./route";

interface FreeCallBuyer {
  agentId: string;
  orgId: string;
}

/**
 * Claims one of a buyer's free Calls for this Endpoint, or returns null when none are left.
 * The Call row is the claim, so concurrent requests can't exceed the quota. Free Calls write
 * no Ledger entries.
 */
export function claimFreeCall(
  db: Db,
  route: GatewayRoute,
  buyer: FreeCallBuyer,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Serialises claims per buyer and Endpoint, without holding a lock during the upstream call.
    const lockKey = `free-call:${buyer.orgId}:${route.endpointId}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [used] = await tx
      .select({ total: count() })
      .from(calls)
      .where(
        and(
          eq(calls.buyerOrgId, buyer.orgId),
          eq(calls.endpointId, route.endpointId),
          eq(calls.status, "free"),
          // Seeded traffic is not the buyer's: it must not use up their real allowance.
          eq(calls.simulated, false),
        ),
      );
    if (used!.total >= route.freeQuota) return null;

    const [call] = await tx
      .insert(calls)
      .values({
        agentId: buyer.agentId,
        buyerOrgId: buyer.orgId,
        endpointId: route.endpointId,
        amountMicro: 0n,
        status: "free",
      })
      .returning({ id: calls.id });
    return call!.id;
  });
}

/**
 * Records a Call to an Endpoint priced at $0. There is no quota to guard, so no lock: the
 * row is only the record of the Call. Like a free Call it writes no Ledger entries.
 */
export async function recordZeroPriceCall(
  db: Db,
  route: GatewayRoute,
  buyer: FreeCallBuyer,
): Promise<string> {
  const [call] = await db
    .insert(calls)
    .values({
      agentId: buyer.agentId,
      buyerOrgId: buyer.orgId,
      endpointId: route.endpointId,
      amountMicro: 0n,
      status: "free",
    })
    .returning({ id: calls.id });
  return call!.id;
}

/** Records how a claimed free Call ended. */
export async function completeFreeCall(
  db: Db,
  callId: string,
  outcome: { upstreamStatus: number; latencyMs: number },
): Promise<void> {
  await db.update(calls).set(outcome).where(eq(calls.id, callId));
}

/** Gives a claimed free Call back: the upstream failed, so it doesn't use up the quota. */
export async function releaseFreeCall(db: Db, callId: string): Promise<void> {
  await db.delete(calls).where(eq(calls.id, callId));
}
