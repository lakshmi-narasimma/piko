/**
 * Alerts for the Org console (BACKLOG P5-08): breaker trips, Budget hits, Policy denials and
 * freezes, newest first, with an unread count for the navigation badge.
 *
 * Read state: the `alerts` table has no read column, so "unread" means "created after this
 * browser last marked the alerts read". That moment lives in the {@link ALERTS_SEEN_COOKIE}
 * cookie. With no cookie, every alert from the last 24 hours counts as unread.
 */
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { BudgetState } from "../budgets";
import type { Db } from "../db/client";
import { agents, alerts } from "../db/schema";
import type { DbOrTx } from "../ledger";
import { formatUsd } from "../money";
import { BUDGET_ALERT_TYPE, type AlertView } from "./types";

export * from "./types";

/** A looping Agent hitting one cap writes one alert per this many seconds, not one per try. */
export const BUDGET_ALERT_DEDUP_SECONDS = 600;

/** Holds the ISO time this browser last marked the org's alerts read. */
export const ALERTS_SEEN_COOKIE = "piko_alerts_seen";

/** How far back the unread count looks when the alerts were never marked read. */
export const UNREAD_DEFAULT_HOURS = 24;

export const DEFAULT_ALERT_LIMIT = 50;

/** Where a client left off. Opaque to it: pass back what the last answer returned. */
export interface AlertCursor {
  /** Postgres's own text for created_at, so microseconds survive the round trip. */
  at: string;
  id: string;
}

const select = (db: DbOrTx) =>
  db
    .select({
      id: alerts.id,
      type: alerts.type,
      agentId: alerts.agentId,
      agent: agents.name,
      message: alerts.message,
      at: sql<string>`${alerts.createdAt}::text`,
    })
    .from(alerts)
    .leftJoin(agents, eq(agents.id, alerts.agentId));

type Row = Awaited<ReturnType<ReturnType<typeof select>["limit"]>>[number];

const toView = (row: Row): AlertView => ({
  id: row.id,
  type: row.type,
  agentId: row.agentId,
  agent: row.agent,
  message: row.message,
  createdAt: new Date(row.at).toISOString(),
});

/** An org's latest alerts, newest first, and the cursor to ask for newer ones after. */
export async function listAlerts(
  db: DbOrTx,
  input: { orgId: string; limit?: number },
): Promise<{ alerts: AlertView[]; cursor: AlertCursor | null }> {
  const rows = await select(db)
    .where(eq(alerts.orgId, input.orgId))
    .orderBy(desc(alerts.createdAt), desc(alerts.id))
    .limit(input.limit ?? DEFAULT_ALERT_LIMIT);
  const newest = rows[0];
  return {
    alerts: rows.map(toView),
    cursor: newest ? { at: newest.at, id: newest.id } : null,
  };
}

/** An org's alerts written after the cursor, newest first. */
export async function alertsAfter(
  db: DbOrTx,
  input: { orgId: string; cursor: AlertCursor; limit?: number },
): Promise<{ alerts: AlertView[]; cursor: AlertCursor }> {
  const { at, id } = input.cursor;
  const rows = await select(db)
    .where(
      and(
        eq(alerts.orgId, input.orgId),
        sql`(${alerts.createdAt}, ${alerts.id}) > (${at}::timestamptz, ${id}::uuid)`,
      ),
    )
    .orderBy(asc(alerts.createdAt), asc(alerts.id))
    .limit(input.limit ?? DEFAULT_ALERT_LIMIT);
  const newest = rows.at(-1);
  return {
    alerts: rows.reverse().map(toView),
    cursor: newest ? { at: newest.at, id: newest.id } : input.cursor,
  };
}

/** The moment unread starts: the cookie's time if it holds one, else 24 hours ago. */
export function unreadSince(seenCookie: string | undefined, now = new Date()): Date {
  const seen = seenCookie ? new Date(seenCookie) : null;
  if (seen && !Number.isNaN(seen.getTime())) return seen;
  return new Date(now.getTime() - UNREAD_DEFAULT_HOURS * 3600_000);
}

/** How many of an org's alerts were written after `since`: the badge's number. */
export async function countUnread(
  db: DbOrTx,
  input: { orgId: string; since: Date },
): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.orgId, input.orgId), gt(alerts.createdAt, input.since)));
  return Number(row!.n);
}

const PER: Record<BudgetState["period"], string> = {
  day: "per day",
  month: "per month",
  task: "per task",
};

/**
 * Writes a `budget_exceeded` alert for a payment a Budget blocked, unless the same Agent got
 * the same alert in the last {@link BUDGET_ALERT_DEDUP_SECONDS}. Returns whether it wrote one.
 * A lock per Agent makes concurrent blocked payments write one alert between them.
 */
export async function recordBudgetAlert(
  db: Db,
  input: { orgId: string; agentId: string; budget: BudgetState },
): Promise<boolean> {
  const { orgId, agentId, budget } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alert:budget:${agentId}`}))`);
    const [agent] = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    if (!agent) return false;
    const message =
      `${agent.name} hit the ${budget.scope} budget of ${formatUsd(budget.maxMicro)} ` +
      `${PER[budget.period]}${budget.category ? ` on ${budget.category}` : ""}. Payments over it are blocked.`;
    const [recent] = await tx
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.orgId, orgId),
          eq(alerts.agentId, agentId),
          eq(alerts.type, BUDGET_ALERT_TYPE),
          eq(alerts.message, message),
          gt(
            alerts.createdAt,
            sql`clock_timestamp() - make_interval(secs => ${BUDGET_ALERT_DEDUP_SECONDS})`,
          ),
        ),
      )
      .limit(1);
    if (recent) return false;
    await tx.insert(alerts).values({ orgId, agentId, type: BUDGET_ALERT_TYPE, message });
    return true;
  });
}
