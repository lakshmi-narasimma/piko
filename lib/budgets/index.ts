/**
 * Budgets (docs/DESIGN.md section 9): spending caps on an org, a team or an Agent, per day,
 * month or task, optionally for one Listing category. Enforcement is deterministic code.
 *
 * What a Budget has used is its scope's spend in the current period, from the Ledger:
 * the buyer's wallet entries for Calls (refunds net out), plus every active reservation,
 * because a held amount is about to be spent. Counting holds is what stops two concurrent
 * payments from both slipping under the cap: reserveFunds runs the check under the buyer
 * org's lock, after every earlier hold has committed.
 *
 * Periods are UTC, and the current one is found with the database clock, which also sets
 * `calls.created_at`. A Call counts in the period of its `created_at`, and so does its
 * refund. A `task` Budget counts everything since the Budget was created: a new task starts
 * when its cap is changed (docs/decisions/0013-task-budgets.md).
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  agents,
  budgets,
  calls,
  challenges,
  endpoints,
  ledgerEntries,
  listings,
  teams,
} from "../db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../ledger";

export type BudgetScope = "org" | "team" | "agent";
export type BudgetPeriod = "day" | "month" | "task";

/** Checked in this order; the first exceeded Budget is the one reported. */
const SCOPE_ORDER: readonly BudgetScope[] = ["agent", "team", "org"];

/** Who is paying. `teamId` must be the Agent's team in `orgId`, or null. */
export interface Spender {
  orgId: string;
  teamId: string | null;
  agentId: string;
}

export interface BudgetState {
  budgetId: string;
  scope: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  category: string | null;
  maxMicro: bigint;
  /** Settled Calls in the current period, net of refunds. */
  spentMicro: bigint;
  /** Active reservations not yet settled. */
  heldMicro: bigint;
  /** What can still be spent: max minus spent and held, never below zero. */
  remainingMicro: bigint;
  /** The current period: [from, to). `to` is null for a task Budget. */
  from: Date;
  to: Date | null;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly budget: BudgetState,
    public readonly amountMicro: bigint,
  ) {
    super(
      `The ${budget.scope} ${budget.period} budget has ${budget.remainingMicro} micro-USD left, ` +
        `but this payment needs ${amountMicro}.`,
    );
    this.name = "BudgetExceededError";
  }
}

export class BudgetError extends Error {
  constructor(
    public readonly code: "scope_not_found" | "invalid_amount",
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

/** The period that contains `at`, in UTC. A task period starts when its Budget was made. */
export function periodWindow(
  period: BudgetPeriod,
  at: Date,
  budgetCreatedAt: Date,
): { from: Date; to: Date | null } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  switch (period) {
    case "day":
      return { from: new Date(Date.UTC(y, m, d)), to: new Date(Date.UTC(y, m, d + 1)) };
    case "month":
      return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
    case "task":
      return { from: budgetCreatedAt, to: null };
  }
}

/**
 * The current period by the database clock, so that its edges agree with
 * `calls.created_at` (set by `now()`). Inside a transaction `now()` is its start time.
 */
async function currentWindow(
  db: DbOrTx,
  period: BudgetPeriod,
  budgetCreatedAt: Date,
): Promise<{ from: Date; to: Date | null }> {
  if (period === "task") return { from: budgetCreatedAt, to: null };
  const unit = sql.raw(period === "day" ? "'day'" : "'month'");
  const step = sql.raw(period === "day" ? "interval '1 day'" : "interval '1 month'");
  const result = await db.execute<{ from: Date; to: Date }>(sql`
    select date_trunc(${unit}, now() at time zone 'UTC') at time zone 'UTC' as "from",
           (date_trunc(${unit}, now() at time zone 'UTC') + ${step}) at time zone 'UTC' as "to"
  `);
  const row = result.rows[0]!;
  return { from: new Date(row.from), to: new Date(row.to) };
}

const sameCategory = (column: typeof listings.category, category: string) =>
  sql`lower(${column}) = lower(${category})`;

type BudgetRow = typeof budgets.$inferSelect;

/**
 * The Budgets that cover this spender, agent first, then team, then org. Only rows whose
 * scope is the spender's own Agent, team or org, under the spender's org, can match: a
 * Budget row naming another org's scope never applies. With `category` set, only Budgets
 * for that category or for every category; with it undefined, all of them.
 */
async function coveringBudgets(
  db: DbOrTx,
  spender: Spender,
  category?: string | null,
): Promise<BudgetRow[]> {
  const scopes = [
    and(eq(budgets.scopeType, "agent"), eq(budgets.scopeId, spender.agentId)),
    and(eq(budgets.scopeType, "org"), eq(budgets.scopeId, spender.orgId)),
  ];
  if (spender.teamId) {
    scopes.push(and(eq(budgets.scopeType, "team"), eq(budgets.scopeId, spender.teamId)));
  }
  const rows = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.orgId, spender.orgId),
        or(...scopes),
        category === undefined
          ? undefined
          : category === null
            ? isNull(budgets.category)
            : or(isNull(budgets.category), sql`lower(${budgets.category}) = lower(${category})`),
      ),
    )
    .orderBy(asc(budgets.createdAt), asc(budgets.id));
  return rows.sort((a, b) => SCOPE_ORDER.indexOf(a.scopeType) - SCOPE_ORDER.indexOf(b.scopeType));
}

/** The filter that picks a Budget's scope out of rows joined with `agents`. */
function scopeFilter(budget: BudgetRow, agentColumn: AnyPgColumn) {
  switch (budget.scopeType) {
    case "agent":
      return eq(agentColumn, budget.scopeId);
    case "team":
      return eq(agents.teamId, budget.scopeId);
    case "org":
      return undefined; // Every row is already the org's.
  }
}

async function stateOf(
  db: DbOrTx,
  budget: BudgetRow,
  at: Date | undefined,
  excludeNonce: string | undefined,
): Promise<BudgetState> {
  const { from, to } = at
    ? periodWindow(budget.period, at, budget.createdAt)
    : await currentWindow(db, budget.period, budget.createdAt);
  const category = budget.category;

  // Wallet entries are debits (negative) for Calls and credits for their refunds.
  const [settled] = await db
    .select({ total: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}), 0)` })
    .from(ledgerEntries)
    .innerJoin(calls, eq(ledgerEntries.refId, sql`${calls.id}::text`))
    .innerJoin(agents, eq(agents.id, calls.agentId))
    .innerJoin(endpoints, eq(endpoints.id, calls.endpointId))
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .where(
      and(
        eq(ledgerEntries.accountType, "wallet"),
        eq(ledgerEntries.orgId, budget.orgId),
        inArray(ledgerEntries.reason, ["call", "refund"]),
        eq(calls.buyerOrgId, budget.orgId),
        gte(calls.createdAt, from),
        to ? lt(calls.createdAt, to) : undefined,
        scopeFilter(budget, calls.agentId),
        category === null ? undefined : sameCategory(listings.category, category),
      ),
    );

  // A hold is about to be spent, so it counts now, whenever it was taken.
  const [held] = await db
    .select({ total: sql<string>`coalesce(sum(${challenges.amountMicro}), 0)` })
    .from(challenges)
    .innerJoin(agents, eq(agents.id, challenges.agentId))
    .innerJoin(endpoints, eq(endpoints.id, challenges.endpointId))
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .where(
      and(
        eq(challenges.buyerOrgId, budget.orgId),
        isNotNull(challenges.reservedAt),
        isNull(challenges.consumedAt),
        gt(challenges.reservationExpiresAt, sql`clock_timestamp()`),
        excludeNonce === undefined ? undefined : ne(challenges.nonce, excludeNonce),
        scopeFilter(budget, challenges.agentId),
        category === null ? undefined : sameCategory(listings.category, category),
      ),
    );

  const spentMicro = BigInt(settled!.total);
  const heldMicro = BigInt(held!.total);
  const left = budget.maxMicro - spentMicro - heldMicro;
  return {
    budgetId: budget.id,
    scope: budget.scopeType,
    scopeId: budget.scopeId,
    period: budget.period,
    category,
    maxMicro: budget.maxMicro,
    spentMicro,
    heldMicro,
    remainingMicro: left > 0n ? left : 0n,
    from,
    to,
  };
}

/**
 * Every Budget that covers this spender, with what is left of it, agent first. For the
 * Wallet and Org console views: advisory, since it takes no lock.
 */
export async function budgetStates(
  db: DbOrTx,
  spender: Spender,
  options: { at?: Date } = {},
): Promise<BudgetState[]> {
  const rows = await coveringBudgets(db, spender);
  return Promise.all(rows.map((row) => stateOf(db, row, options.at, undefined)));
}

export interface EnforceBudgetsInput extends Spender {
  endpointId: string;
  amountMicro: bigint;
  /** The Challenge being paid. Its own hold, if it has one already, isn't counted again. */
  nonce?: string;
  /** When the payment happens; picks the day or month. Defaults to the database's now(). */
  at?: Date;
}

/**
 * Refuses a payment that would take any covering Budget over its cap: agent, then team,
 * then org. A Budget for a category only covers Calls to Listings in that category.
 * Race-safe only inside reserveFunds' `beforeHold`, under the buyer org's lock.
 *
 * @throws BudgetExceededError naming the first Budget that can't cover `amountMicro`.
 */
export async function enforceBudgets(db: DbOrTx, input: EnforceBudgetsInput): Promise<void> {
  const [listing] = await db
    .select({ category: listings.category })
    .from(endpoints)
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .where(eq(endpoints.id, input.endpointId));
  const rows = await coveringBudgets(db, input, listing?.category ?? null);
  for (const row of rows) {
    const state = await stateOf(db, row, input.at, input.nonce);
    if (input.amountMicro > state.remainingMicro) {
      throw new BudgetExceededError(state, input.amountMicro);
    }
  }
}

export interface NewBudget {
  orgId: string;
  scopeType: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  maxMicro: bigint;
  category?: string | null;
}

/**
 * Creates a Budget after checking that its scope (the org itself, or one of its teams or
 * Agents) belongs to `orgId`: `budgets.scope_id` has no foreign key to do it.
 *
 * @throws BudgetError `scope_not_found` or `invalid_amount`.
 */
export async function createBudget(db: DbOrTx, input: NewBudget): Promise<BudgetRow> {
  if (input.maxMicro < 0n) {
    throw new BudgetError("invalid_amount", "A budget can't be negative.");
  }
  const { orgId, scopeType, scopeId } = input;
  let owned: boolean;
  if (scopeType === "org") {
    owned = scopeId === orgId;
  } else {
    const found =
      scopeType === "team"
        ? await db
            .select({ id: teams.id })
            .from(teams)
            .where(and(eq(teams.id, scopeId), eq(teams.orgId, orgId)))
        : await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, scopeId), eq(agents.orgId, orgId)));
    owned = found.length > 0;
  }
  if (!owned) {
    throw new BudgetError("scope_not_found", `No ${scopeType} ${scopeId} in this org.`);
  }
  const category = input.category?.trim() || null;
  const [row] = await db
    .insert(budgets)
    .values({ ...input, category })
    .returning();
  return row!;
}
