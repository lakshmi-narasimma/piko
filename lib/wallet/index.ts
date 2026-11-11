/**
 * What the Wallet screen shows and changes. Every mutation takes the signed-in org's id and
 * checks that the agent or key belongs to it, because the ids come from the browser.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, apiKeys, budgets } from "../db/schema";
import { createKey, revokeKey, type CreatedKey } from "../keys";
import { balanceOf } from "../ledger";

export interface WalletKey {
  id: string;
  prefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface WalletAgent {
  id: string;
  name: string;
  notifyAboveMicro: bigint | null;
  taskBudgetMicro: bigint | null;
  dayBudgetMicro: bigint | null;
  keys: WalletKey[];
}

export interface WalletView {
  balanceMicro: bigint;
  agents: WalletAgent[];
}

export async function loadWallet(db: Db, orgId: string): Promise<WalletView> {
  const balanceMicro = await balanceOf(db, { type: "wallet", orgId });
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .orderBy(asc(agents.createdAt));
  const ids = agentRows.map((agent) => agent.id);
  const [keyRows, budgetRows] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(apiKeys)
          .where(inArray(apiKeys.agentId, ids))
          .orderBy(asc(apiKeys.createdAt)),
        db
          .select()
          .from(budgets)
          .where(
            and(
              eq(budgets.orgId, orgId),
              eq(budgets.scopeType, "agent"),
              inArray(budgets.scopeId, ids),
              isNull(budgets.category),
            ),
          ),
      ])
    : [[], []];

  return {
    balanceMicro,
    agents: agentRows.map((agent) => {
      const limit = (period: "task" | "day") =>
        budgetRows.find((b) => b.scopeId === agent.id && b.period === period)?.maxMicro ?? null;
      return {
        id: agent.id,
        name: agent.name,
        notifyAboveMicro: agent.notifyAboveMicro,
        taskBudgetMicro: limit("task"),
        dayBudgetMicro: limit("day"),
        keys: keyRows
          .filter((key) => key.agentId === agent.id)
          .map(({ id, prefix, createdAt, revokedAt }) => ({ id, prefix, createdAt, revokedAt })),
      };
    }),
  };
}

export class WalletError extends Error {
  constructor(
    public readonly code: "agent_not_found" | "key_not_found" | "invalid_amount",
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

async function requireAgent(db: Db, orgId: string, agentId: string) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new WalletError("agent_not_found", "No such agent.");
}

/** A limit in micro-USD, or null to clear it. */
export interface AgentLimits {
  taskBudgetMicro: bigint | null;
  dayBudgetMicro: bigint | null;
  notifyAboveMicro: bigint | null;
}

/** Saves an agent's budgets (per task and per day) and its "notify above" threshold. */
export async function setAgentLimits(
  db: Db,
  input: { orgId: string; agentId: string; limits: AgentLimits },
): Promise<void> {
  const { orgId, agentId, limits } = input;
  for (const value of Object.values(limits)) {
    if (value !== null && value < 0n) {
      throw new WalletError("invalid_amount", "Limits can't be negative.");
    }
  }
  await requireAgent(db, orgId, agentId);

  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ notifyAboveMicro: limits.notifyAboveMicro })
      .where(eq(agents.id, agentId));
    for (const [period, max] of [
      ["task", limits.taskBudgetMicro],
      ["day", limits.dayBudgetMicro],
    ] as const) {
      await tx
        .delete(budgets)
        .where(
          and(
            eq(budgets.orgId, orgId),
            eq(budgets.scopeType, "agent"),
            eq(budgets.scopeId, agentId),
            eq(budgets.period, period),
            isNull(budgets.category),
          ),
        );
      if (max !== null) {
        await tx
          .insert(budgets)
          .values({ orgId, scopeType: "agent", scopeId: agentId, period, maxMicro: max });
      }
    }
  });
}

/** Creates a Key for one of the org's agents. The raw key is in the result, once. */
export async function createAgentKey(
  db: Db,
  input: { orgId: string; agentId: string },
): Promise<CreatedKey> {
  await requireAgent(db, input.orgId, input.agentId);
  return createKey(db, input.agentId);
}

/** Revokes a Key, if it belongs to one of the org's agents. */
export async function revokeAgentKey(
  db: Db,
  input: { orgId: string; keyId: string },
): Promise<boolean> {
  const [owned] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .innerJoin(agents, eq(agents.id, apiKeys.agentId))
    .where(and(eq(apiKeys.id, input.keyId), eq(agents.orgId, input.orgId)));
  if (!owned) throw new WalletError("key_not_found", "No such key.");
  return revokeKey(db, input.keyId);
}
