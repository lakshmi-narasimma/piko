import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { agents, budgets, orgs } from "../db/schema";
import { authenticateKey } from "../keys";
import {
  DEFAULT_TASK_BUDGET_MICRO,
  finishPlaygroundRun,
  NoAgentError,
  startPlaygroundRun,
} from "./playground";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("playground run", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url!);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  async function newOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: "PG", slug: `pg-${randomUUID()}`, kind: "personal", billing: "prepaid" })
      .returning({ id: orgs.id });
    return org!.id;
  }

  it("mints a working Key for the org's agent and revokes it when the run ends", async () => {
    const orgId = await newOrg();
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: "shopping-assistant" })
      .returning({ id: agents.id });

    const run = await startPlaygroundRun(db, orgId);
    expect(run).toMatchObject({ agentId: agent!.id, taskBudgetMicro: DEFAULT_TASK_BUDGET_MICRO });
    expect(await authenticateKey(db, run.key)).toMatchObject({ ok: true, orgId });

    await finishPlaygroundRun(db, run);
    expect((await authenticateKey(db, run.key)).ok).toBe(false);
  });

  it("uses the agent's own per-task budget when it has one", async () => {
    const orgId = await newOrg();
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: "a" })
      .returning({ id: agents.id });
    await db.insert(budgets).values({
      orgId,
      scopeType: "agent",
      scopeId: agent!.id,
      period: "task",
      maxMicro: 1_000_000n,
    });
    expect((await startPlaygroundRun(db, orgId)).taskBudgetMicro).toBe(1_000_000n);
  });

  it("refuses an org with no agent", async () => {
    await expect(startPlaygroundRun(db, await newOrg())).rejects.toBeInstanceOf(NoAgentError);
  });
});
