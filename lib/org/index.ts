/**
 * What the Org console's team and agent tree shows and changes (BACKLOG P5-01).
 *
 * Every mutation takes the signed-in principal and works only inside that principal's org,
 * because team and agent ids come from the browser. Only admins may change the tree.
 *
 * Spend here is a simple sum of this calendar month's (UTC) wallet Ledger entries for each
 * agent's Calls. P5-02's budget engine (lib/budgets) replaces this calculation.
 */
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { agents, budgets, calls, ledgerEntries, teams } from "../db/schema";

export type BudgetPeriod = "day" | "month" | "task";

export interface TreeBudget {
  period: BudgetPeriod;
  maxMicro: bigint;
  category: string | null;
}

/** Spend so far this month, in micro-USD. `simulatedMicro` is the part from simulated Calls. */
export interface Spend {
  spentMicro: bigint;
  simulatedMicro: bigint;
}

export interface TreeAgent extends Spend {
  id: string;
  name: string;
  teamId: string | null;
  frozen: boolean;
  budgets: TreeBudget[];
}

export interface TreeTeam extends Spend {
  id: string;
  name: string;
  frozen: boolean;
  budgets: TreeBudget[];
  agents: TreeAgent[];
}

export interface OrgTree extends Spend {
  orgId: string;
  budgets: TreeBudget[];
  teams: TreeTeam[];
  /** Agents in no team. */
  unassigned: TreeAgent[];
}

/** Who is acting. Pass the signed-in Principal. */
export interface Actor {
  org: { id: string };
  role: "admin" | "member";
}

export class OrgError extends Error {
  constructor(
    public readonly code:
      "forbidden" | "invalid_input" | "team_not_found" | "agent_not_found" | "name_taken",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

const monthStart = sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;

/** Net spend this month per agent: Calls debit the wallet, refunds credit it back. */
async function spendByAgent(db: Db, orgId: string): Promise<Map<string, Spend>> {
  const rows = await db
    .select({
      agentId: calls.agentId,
      spent: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}), 0)`,
      simulated: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}) filter (where ${calls.simulated}), 0)`,
    })
    .from(ledgerEntries)
    .innerJoin(calls, sql`${calls.id}::text = ${ledgerEntries.refId}`)
    .where(
      and(
        eq(ledgerEntries.accountType, "wallet"),
        eq(ledgerEntries.orgId, orgId),
        inArray(ledgerEntries.reason, ["call", "refund"]),
        eq(calls.buyerOrgId, orgId),
        gte(ledgerEntries.createdAt, monthStart),
      ),
    )
    .groupBy(calls.agentId);
  return new Map(
    rows.map((row) => [
      row.agentId,
      { spentMicro: BigInt(row.spent), simulatedMicro: BigInt(row.simulated) },
    ]),
  );
}

function total(items: Spend[]): Spend {
  return items.reduce(
    (sum, item) => ({
      spentMicro: sum.spentMicro + item.spentMicro,
      simulatedMicro: sum.simulatedMicro + item.simulatedMicro,
    }),
    { spentMicro: 0n, simulatedMicro: 0n },
  );
}

/** The org's teams and agents, each with its budgets and spend so far this month. */
export async function loadOrgTree(db: Db, orgId: string): Promise<OrgTree> {
  const [teamRows, agentRows, budgetRows, spend] = await Promise.all([
    db
      .select()
      .from(teams)
      .where(eq(teams.orgId, orgId))
      .orderBy(asc(teams.createdAt), asc(teams.name)),
    db
      .select()
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .orderBy(asc(agents.createdAt), asc(agents.name)),
    db.select().from(budgets).where(eq(budgets.orgId, orgId)).orderBy(asc(budgets.createdAt)),
    spendByAgent(db, orgId),
  ]);

  const budgetsFor = (scopeType: "org" | "team" | "agent", scopeId: string): TreeBudget[] =>
    budgetRows
      .filter((b) => b.scopeType === scopeType && b.scopeId === scopeId)
      .map(({ period, maxMicro, category }) => ({ period, maxMicro, category }));

  const treeAgents: TreeAgent[] = agentRows.map((agent) => ({
    id: agent.id,
    name: agent.name,
    teamId: agent.teamId,
    frozen: agent.frozenAt !== null,
    budgets: budgetsFor("agent", agent.id),
    ...(spend.get(agent.id) ?? { spentMicro: 0n, simulatedMicro: 0n }),
  }));

  const treeTeams: TreeTeam[] = teamRows.map((team) => {
    const members = treeAgents.filter((agent) => agent.teamId === team.id);
    return {
      id: team.id,
      name: team.name,
      frozen: team.frozenAt !== null,
      budgets: budgetsFor("team", team.id),
      agents: members,
      ...total(members),
    };
  });

  return {
    orgId,
    budgets: budgetsFor("org", orgId),
    teams: treeTeams,
    unassigned: treeAgents.filter((agent) => agent.teamId === null),
    ...total(treeAgents),
  };
}

function requireAdmin(actor: Actor): string {
  if (actor.role !== "admin") {
    throw new OrgError("forbidden", "Only an org admin can change teams and agents.");
  }
  return actor.org.id;
}

const teamName = z
  .string()
  .trim()
  .min(1, "Give the team a name.")
  .max(60, "Keep it under 60 characters.");
const agentName = z
  .string()
  .trim()
  .min(1, "Give the agent a name.")
  .max(60, "Keep it under 60 characters.")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and dashes, like ticket-triage.");
const optionalId = z.uuid("No such team.").nullable();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new OrgError("invalid_input", result.error.issues[0]?.message ?? "Invalid input.");
  }
  return result.data;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if ((e as Error & { code?: string }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

/** Throws unless the team exists in this org. A null team means "no team". */
async function requireTeam(db: Db, orgId: string, teamId: string | null): Promise<void> {
  if (teamId === null) return;
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)));
  if (!team) throw new OrgError("team_not_found", "No such team.");
}

export async function createTeam(
  db: Db,
  actor: Actor,
  input: { name: unknown },
): Promise<{ id: string }> {
  const orgId = requireAdmin(actor);
  const name = parse(teamName, input.name);
  try {
    const [row] = await db.insert(teams).values({ orgId, name }).returning({ id: teams.id });
    return row!;
  } catch (error) {
    if (isUniqueViolation(error))
      throw new OrgError("name_taken", `There's already a team called ${name}.`);
    throw error;
  }
}

export async function createAgent(
  db: Db,
  actor: Actor,
  input: { name: unknown; teamId: unknown },
): Promise<{ id: string }> {
  const orgId = requireAdmin(actor);
  const name = parse(agentName, input.name);
  const teamId = parse(optionalId, input.teamId);
  await requireTeam(db, orgId, teamId);
  try {
    const [row] = await db
      .insert(agents)
      .values({ orgId, teamId, name })
      .returning({ id: agents.id });
    return row!;
  } catch (error) {
    if (isUniqueViolation(error))
      throw new OrgError("name_taken", `There's already an agent called ${name}.`);
    throw error;
  }
}

/** Moves one of the org's agents into another of its teams, or out of every team (null). */
export async function moveAgent(
  db: Db,
  actor: Actor,
  input: { agentId: unknown; teamId: unknown },
): Promise<void> {
  const orgId = requireAdmin(actor);
  const agentId = parse(z.uuid("No such agent."), input.agentId);
  const teamId = parse(optionalId, input.teamId);
  await requireTeam(db, orgId, teamId);
  // Scoping the update to the org means another org's agent matches nothing. The
  // agents_team_same_org_fk constraint backs up the team check above.
  const moved = await db
    .update(agents)
    .set({ teamId })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning({ id: agents.id });
  if (moved.length === 0) throw new OrgError("agent_not_found", "No such agent.");
}
