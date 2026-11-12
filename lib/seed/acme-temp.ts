/**
 * TEMPORARY until P9-01: Acme Corp's teams, agents and budgets (docs/SEED_DATA.md §2), so
 * the Org console (P5-01) has a tree to show. P9-01 replaces this with the full demo world
 * and deletes this file.
 *
 * Acme Corp and Dana are created only if the seed hasn't already made them (matched on the
 * slug `acme` and the email `dana@acme.demo`), so this works with or without the main seed
 * creating them.
 */
import { and, eq, sql } from "drizzle-orm";
import { accounts, agents, budgets, memberships, orgs, teams } from "../db/schema";
import type { DbOrTx } from "../ledger";

/** Acme's monthly org budget, $300. */
export const ACME_TEMP_ORG_BUDGET_MICRO = 300_000_000n;

/** Acme's teams, their monthly budgets and their agents, in display order. */
export const ACME_TEMP_TEAMS = [
  {
    name: "Marketing",
    monthlyMicro: 50_000_000n,
    agents: ["campaign-researcher", "competitor-watch"],
  },
  { name: "Support", monthlyMicro: 80_000_000n, agents: ["ticket-triage"] },
  { name: "Data", monthlyMicro: 150_000_000n, agents: ["catalog-sync", "loop-bot"] },
] as const;

async function ensureAcmeAndDana(db: DbOrTx): Promise<string> {
  let [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, "acme"));
  if (!org) {
    [org] = await db
      .insert(orgs)
      .values({
        name: "Acme Corp",
        slug: "acme",
        kind: "company",
        billing: "invoiced",
        creditLimitMicro: 500_000_000n,
      })
      .returning({ id: orgs.id });
  }
  const orgId = org!.id;

  let [dana] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(sql`lower(${accounts.email})`, "dana@acme.demo"));
  if (!dana) {
    [dana] = await db
      .insert(accounts)
      .values({ email: "dana@acme.demo", name: "Dana" })
      .returning({ id: accounts.id });
  }
  const [member] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.accountId, dana!.id), eq(memberships.orgId, orgId)));
  if (!member) {
    await db.insert(memberships).values({ accountId: dana!.id, orgId, role: "admin" });
  }
  return orgId;
}

/** Adds Acme's 3 teams, 5 agents and monthly budgets. Run it on a freshly reset database. */
export async function seedAcmeTemp(db: DbOrTx): Promise<{ orgId: string }> {
  const orgId = await ensureAcmeAndDana(db);

  await db.insert(budgets).values({
    orgId,
    scopeType: "org",
    scopeId: orgId,
    period: "month",
    maxMicro: ACME_TEMP_ORG_BUDGET_MICRO,
  });

  // The seed runs in one transaction, where now() never moves, so rows get explicit and
  // increasing creation times: the console lists teams and agents in creation order.
  const start = Date.now();
  let step = 0;
  const nextCreatedAt = () => new Date(start + step++);

  for (const team of ACME_TEMP_TEAMS) {
    const [row] = await db
      .insert(teams)
      .values({ orgId, name: team.name, createdAt: nextCreatedAt() })
      .returning({ id: teams.id });
    await db.insert(budgets).values({
      orgId,
      scopeType: "team",
      scopeId: row!.id,
      period: "month",
      maxMicro: team.monthlyMicro,
    });
    await db
      .insert(agents)
      .values(
        team.agents.map((name) => ({ orgId, teamId: row!.id, name, createdAt: nextCreatedAt() })),
      );
  }

  return { orgId };
}
