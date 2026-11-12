/**
 * A playground run's identity. The agent pays with a Key of its own, made for the run and
 * revoked when it ends, so a run never reuses (or needs to know) a Key a person saved.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, budgets } from "../db/schema";
import { createKey, revokeKey } from "../keys";

/** What a run may spend when the buyer hasn't set a per-task budget: ten cents. */
export const DEFAULT_TASK_BUDGET_MICRO = 100_000n;

export interface PlaygroundRun {
  agentId: string;
  agentName: string;
  keyId: string;
  /** The run's raw Key. Server-side only. */
  key: string;
  taskBudgetMicro: bigint;
}

export class NoAgentError extends Error {
  constructor() {
    super("This account has no agent to run the playground with.");
    this.name = "NoAgentError";
  }
}

/** Picks the org's first agent, reads its task budget, and mints a Key for the run. */
export async function startPlaygroundRun(db: Db, orgId: string): Promise<PlaygroundRun> {
  const [agent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  if (!agent) throw new NoAgentError();

  const [budget] = await db
    .select({ maxMicro: budgets.maxMicro })
    .from(budgets)
    .where(
      and(
        eq(budgets.orgId, orgId),
        eq(budgets.scopeType, "agent"),
        eq(budgets.scopeId, agent.id),
        eq(budgets.period, "task"),
        isNull(budgets.category),
      ),
    );

  const key = await createKey(db, agent.id);
  return {
    agentId: agent.id,
    agentName: agent.name,
    keyId: key.id,
    key: key.rawKey,
    taskBudgetMicro: budget?.maxMicro ?? DEFAULT_TASK_BUDGET_MICRO,
  };
}

export async function finishPlaygroundRun(db: Db, run: Pick<PlaygroundRun, "keyId">) {
  await revokeKey(db, run.keyId);
}
