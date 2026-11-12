/**
 * Org invoices (docs/DESIGN.md sections 5.1(f) and 7.4): an invoiced org's spend for one
 * calendar month, with one line per team, worked out from the Ledger. This is pure
 * computation: it writes nothing. Creating and sending the PayPal invoice is P7-02.
 *
 * Spend follows lib/budgets: the buyer's wallet entries for Calls, so a refund nets its
 * Call out. A Call counts in the month of its `created_at` (set by the database clock), and
 * so does its refund. Months are UTC.
 *
 * A Call is put on the line of its Agent's current team; an Agent in no team goes on the
 * "No team" line. Calls don't record a team, so an Agent moved mid-month takes its spend
 * with it.
 *
 * Simulated Calls are included in the totals, because the ledger is the bill, and each line
 * reports the simulated share in `simulatedMicro` so the UI can label it (demo honesty).
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { agents, calls, ledgerEntries, orgs, teams } from "../db/schema";
import type { DbOrTx } from "../ledger";

export const NO_TEAM_NAME = "No team";

export interface InvoiceLine {
  /** Null for Agents in no team. */
  teamId: string | null;
  teamName: string;
  /** Net spend: Calls minus their refunds. */
  amountMicro: bigint;
  /** Charged Calls that were not refunded. */
  callCount: number;
  /** The part of `amountMicro` from simulated Calls. */
  simulatedMicro: bigint;
}

export interface Invoice {
  orgId: string;
  /** `YYYY-MM`, as stored in `invoices.period`. */
  period: string;
  /** Start of the month, inclusive, UTC. */
  from: Date;
  /** Start of the next month, exclusive, UTC. */
  to: Date;
  /** Only teams with Calls in the period, by team name, then "No team" last. */
  lines: InvoiceLine[];
  totalMicro: bigint;
  simulatedMicro: bigint;
}

export class InvoiceError extends Error {
  constructor(
    public readonly code: "invalid_period" | "org_not_found" | "not_invoiced",
    message: string,
  ) {
    super(message);
    this.name = "InvoiceError";
  }
}

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The UTC month a `YYYY-MM` period covers: [from, to). */
export function periodBounds(period: string): { from: Date; to: Date } {
  const match = PERIOD.exec(period);
  if (!match) {
    throw new InvoiceError("invalid_period", `"${period}" is not a YYYY-MM period.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)) };
}

/** This month as `YYYY-MM`, by the database clock in UTC, for "Generate this month's invoice". */
export async function currentPeriod(db: DbOrTx): Promise<string> {
  const result = await db.execute<{ period: string }>(
    sql`select to_char(now() at time zone 'UTC', 'YYYY-MM') as period`,
  );
  return result.rows[0]!.period;
}

/**
 * An invoiced org's bill for `period` (`YYYY-MM`). `totalMicro` equals the org's net wallet
 * debits for Calls in that month.
 *
 * @throws InvoiceError `invalid_period`, `org_not_found`, or `not_invoiced` for a prepaid
 * org, which pays by topping up and never gets an invoice.
 */
export async function computeInvoice(db: DbOrTx, orgId: string, period: string): Promise<Invoice> {
  const { from, to } = periodBounds(period);
  const [org] = await db.select({ billing: orgs.billing }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw new InvoiceError("org_not_found", `No org ${orgId}.`);
  if (org.billing !== "invoiced") {
    throw new InvoiceError("not_invoiced", "This org is prepaid, so it has no invoice.");
  }

  // Wallet entries are debits (negative) for Calls and credits for their refunds.
  const rows = await db
    .select({
      teamId: teams.id,
      teamName: teams.name,
      amount: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}), 0)`,
      simulated: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}) filter (where ${calls.simulated}), 0)`,
      charged: sql<number>`(count(*) filter (where ${ledgerEntries.reason} = 'call'))::int`,
      refunded: sql<number>`(count(*) filter (where ${ledgerEntries.reason} = 'refund'))::int`,
    })
    .from(ledgerEntries)
    .innerJoin(calls, eq(ledgerEntries.refId, sql`${calls.id}::text`))
    .innerJoin(agents, eq(agents.id, calls.agentId))
    .leftJoin(teams, eq(teams.id, agents.teamId))
    .where(
      and(
        eq(ledgerEntries.accountType, "wallet"),
        eq(ledgerEntries.orgId, orgId),
        inArray(ledgerEntries.reason, ["call", "refund"]),
        eq(calls.buyerOrgId, orgId),
        gte(calls.createdAt, from),
        lt(calls.createdAt, to),
      ),
    )
    .groupBy(teams.id, teams.name);

  const lines: InvoiceLine[] = rows
    .map((row) => ({
      teamId: row.teamId,
      teamName: row.teamName ?? NO_TEAM_NAME,
      amountMicro: BigInt(row.amount),
      callCount: row.charged - row.refunded,
      simulatedMicro: BigInt(row.simulated),
    }))
    .sort((a, b) => {
      if ((a.teamId === null) !== (b.teamId === null)) return a.teamId === null ? 1 : -1;
      return a.teamName < b.teamName ? -1 : a.teamName > b.teamName ? 1 : 0;
    });

  return {
    orgId,
    period,
    from,
    to,
    lines,
    totalMicro: lines.reduce((sum, line) => sum + line.amountMicro, 0n),
    simulatedMicro: lines.reduce((sum, line) => sum + line.simulatedMicro, 0n),
  };
}
