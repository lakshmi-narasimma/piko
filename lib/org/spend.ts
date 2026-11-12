/**
 * The Org console's spend grid and audit export (BACKLOG P5-09): one row per Call the org's
 * Agents made in a date range, with who made it, which seller and Endpoint it paid, and what
 * it cost the org.
 *
 * A Call's spend has the same meaning as in the team and agent tree (lib/org) and the budget
 * engine (lib/budgets): the buyer wallet's Ledger entries for that Call, so a refund nets it
 * back to zero. Free and blocked Calls have no entries and show a spend of zero.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, calls, endpoints, ledgerEntries, listings, orgs, teams } from "../db/schema";
import { OrgError, type Actor } from "./index";

export type CallStatus = (typeof calls.$inferSelect)["status"];

export interface SpendRow {
  callId: string;
  at: Date;
  /** The Call's UTC day, YYYY-MM-DD. */
  day: string;
  team: string | null;
  agent: string;
  /** The seller org paid. */
  vendor: string;
  listing: string;
  /** Method and path, or TOOL and the MCP tool name. */
  endpoint: string;
  status: CallStatus;
  /** The Call's price. */
  priceMicro: bigint;
  /** What the Call cost the org's wallet, net of any refund. */
  spentMicro: bigint;
  simulated: boolean;
}

/** A range of UTC days, both ends included. */
export interface DayRange {
  from: string;
  to: string;
}

/** More rows than this and the grid shows only the newest ones, saying so. */
export const SPEND_ROW_LIMIT = 50_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function isDay(text: string): boolean {
  return DAY.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The range to show from the page's `from` and `to` query values, both YYYY-MM-DD. A missing
 * or unreadable value falls back to the last 30 days ending today (UTC); a reversed range is
 * swapped.
 */
export function spendRange(
  input: { from?: string | string[]; to?: string | string[] },
  now = new Date(),
): DayRange {
  const pick = (value: string | string[] | undefined) =>
    typeof value === "string" && isDay(value) ? value : undefined;
  const to = pick(input.to) ?? dayOf(now);
  const from = pick(input.from) ?? dayOf(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS));
  return from <= to ? { from, to } : { from: to, to: from };
}

export interface SpendRows {
  range: DayRange;
  rows: SpendRow[];
  /** True when the range held more than SPEND_ROW_LIMIT Calls and only the newest are here. */
  truncated: boolean;
}

/** Every Call the actor's org made in the range, newest first. Admins only. */
export async function loadSpendRows(
  db: Db,
  actor: Actor,
  range: DayRange,
  limit = SPEND_ROW_LIMIT,
): Promise<SpendRows> {
  if (actor.role !== "admin") {
    throw new OrgError("forbidden", "Only an org admin can see the org's spend.");
  }
  const orgId = actor.org.id;
  const start = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY_MS);

  // Net wallet movement per Call, for this org's Calls only: the charge plus any refund.
  const walletByCall = db
    .select({
      refId: ledgerEntries.refId,
      spent: sql<string>`-sum(${ledgerEntries.amountMicro})`.as("spent"),
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.accountType, "wallet"),
        eq(ledgerEntries.orgId, orgId),
        sql`${ledgerEntries.reason} in ('call', 'refund')`,
      ),
    )
    .groupBy(ledgerEntries.refId)
    .as("wallet_by_call");

  const rows = await db
    .select({
      callId: calls.id,
      at: calls.createdAt,
      team: teams.name,
      agent: agents.name,
      vendor: orgs.name,
      listing: listings.name,
      method: endpoints.method,
      path: endpoints.pathOrTool,
      status: calls.status,
      priceMicro: calls.amountMicro,
      spent: sql<string | null>`${walletByCall.spent}`,
      simulated: calls.simulated,
    })
    .from(calls)
    .innerJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(teams, eq(teams.id, agents.teamId))
    .innerJoin(endpoints, eq(endpoints.id, calls.endpointId))
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .innerJoin(orgs, eq(orgs.id, listings.sellerOrgId))
    .leftJoin(walletByCall, sql`${walletByCall.refId} = ${calls.id}::text`)
    .where(and(eq(calls.buyerOrgId, orgId), gte(calls.createdAt, start), lt(calls.createdAt, end)))
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(limit + 1);

  return {
    range,
    truncated: rows.length > limit,
    rows: rows.slice(0, limit).map((row) => ({
      callId: row.callId,
      at: row.at,
      day: dayOf(row.at),
      team: row.team,
      agent: row.agent,
      vendor: row.vendor,
      listing: row.listing,
      endpoint: `${row.method} ${row.path}`,
      status: row.status,
      priceMicro: row.priceMicro,
      spentMicro: row.spent === null ? 0n : BigInt(row.spent),
      simulated: row.simulated,
    })),
  };
}
