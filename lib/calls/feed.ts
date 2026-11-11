import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, calls, endpoints, listings } from "../db/schema";

export type FeedSide = "buyer" | "seller";

/** One Call as the live feed shows it. Amounts are micro-USD strings, since JSON has no bigint. */
export interface FeedCall {
  id: string;
  createdAt: string;
  agent: string;
  /** "Listing name METHOD /path". */
  endpoint: string;
  amountMicro: string;
  status: "paid" | "free" | "refunded" | "blocked";
  blockReason: string | null;
  simulated: boolean;
}

/** Where a client left off. Opaque to it: pass back what the last response returned. */
export interface FeedCursor {
  /** Postgres's own text for created_at, so microseconds survive the round trip. */
  at: string;
  id: string;
}

const columns = (db: Db) =>
  db
    .select({
      id: calls.id,
      at: sql<string>`${calls.createdAt}::text`,
      agent: agents.name,
      listing: listings.name,
      method: endpoints.method,
      path: endpoints.pathOrTool,
      amountMicro: calls.amountMicro,
      status: calls.status,
      blockReason: calls.blockReason,
      simulated: calls.simulated,
    })
    .from(calls)
    .innerJoin(agents, eq(agents.id, calls.agentId))
    .innerJoin(endpoints, eq(endpoints.id, calls.endpointId))
    .innerJoin(listings, eq(listings.id, endpoints.listingId));

type Row = Awaited<ReturnType<ReturnType<typeof columns>["limit"]>>[number];

function toFeed(rows: Row[]): { calls: FeedCall[]; cursor: FeedCursor | null } {
  const feed = rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.at).toISOString(),
    agent: row.agent,
    endpoint: `${row.listing} ${row.method} ${row.path}`,
    amountMicro: row.amountMicro.toString(),
    status: row.status,
    blockReason: row.blockReason,
    simulated: row.simulated,
  }));
  const last = rows.at(-1);
  return { calls: feed, cursor: last ? { at: last.at, id: last.id } : null };
}

function ownedBy(side: FeedSide, orgId: string) {
  return side === "buyer" ? eq(calls.buyerOrgId, orgId) : eq(listings.sellerOrgId, orgId);
}

/** The newest Calls for an org, oldest first, with the cursor to continue from. */
export async function recentCalls(
  db: Db,
  input: { orgId: string; side: FeedSide; limit?: number },
) {
  const rows = await columns(db)
    .where(ownedBy(input.side, input.orgId))
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(input.limit ?? 20);
  return toFeed(rows.reverse());
}

/** Calls recorded after the cursor, oldest first. */
export async function callsAfter(
  db: Db,
  input: { orgId: string; side: FeedSide; cursor: FeedCursor; limit?: number },
) {
  const { at, id } = input.cursor;
  const rows = await columns(db)
    .where(
      and(
        ownedBy(input.side, input.orgId),
        sql`(${calls.createdAt}, ${calls.id}) > (${at}::timestamptz, ${id}::uuid)`,
      ),
    )
    .orderBy(asc(calls.createdAt), asc(calls.id))
    .limit(input.limit ?? 100);
  const feed = toFeed(rows);
  return { calls: feed.calls, cursor: feed.cursor ?? input.cursor };
}
