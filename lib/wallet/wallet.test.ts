import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { authenticateKey } from "../keys";
import { createDb, type Db } from "../db/client";
import { agents, budgets, ledgerEntries, orgs } from "../db/schema";
import {
  createAgentKey,
  loadWallet,
  revokeAgentKey,
  setAgentLimits,
  type AgentLimits,
} from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("wallet", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url!);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  async function setup() {
    const [org] = await db
      .insert(orgs)
      .values({ name: "W", slug: `w-${randomUUID()}`, kind: "personal", billing: "prepaid" })
      .returning({ id: orgs.id });
    const [agent] = await db
      .insert(agents)
      .values({ orgId: org!.id, name: "bot" })
      .returning({ id: agents.id });
    return { orgId: org!.id, agentId: agent!.id };
  }

  it("shows the balance, the agent and its keys", async () => {
    const { orgId, agentId } = await setup();
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId,
      amountMicro: 5_000_000n,
      reason: "topup",
      refId: `CAP-${randomUUID()}`,
    });
    const key = await createAgentKey(db, { orgId, agentId });

    const view = await loadWallet(db, orgId);
    expect(view.balanceMicro).toBe(5_000_000n);
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]!.keys).toMatchObject([
      { id: key.id, prefix: key.prefix, revokedAt: null },
    ]);
  });

  it("saves, updates and clears limits", async () => {
    const { orgId, agentId } = await setup();
    await setAgentLimits(db, {
      orgId,
      agentId,
      limits: {
        taskBudgetMicro: 1_000_000n,
        dayBudgetMicro: 5_000_000n,
        notifyAboveMicro: 50_000n,
      },
    });
    let [agent] = (await loadWallet(db, orgId)).agents;
    expect(agent).toMatchObject({
      taskBudgetMicro: 1_000_000n,
      dayBudgetMicro: 5_000_000n,
      notifyAboveMicro: 50_000n,
    });

    await setAgentLimits(db, {
      orgId,
      agentId,
      limits: { taskBudgetMicro: 2_000_000n, dayBudgetMicro: null, notifyAboveMicro: null },
    });
    [agent] = (await loadWallet(db, orgId)).agents;
    expect(agent).toMatchObject({
      taskBudgetMicro: 2_000_000n,
      dayBudgetMicro: null,
      notifyAboveMicro: null,
    });
  });

  it("keeps a task budget's window when only another limit changes", async () => {
    const { orgId, agentId } = await setup();
    const save = (limits: AgentLimits) => setAgentLimits(db, { orgId, agentId, limits });
    const taskRow = async () => {
      const [row] = await db
        .select({ id: budgets.id, createdAt: budgets.createdAt })
        .from(budgets)
        .where(and(eq(budgets.scopeId, agentId), eq(budgets.period, "task")));
      return row;
    };

    await save({ taskBudgetMicro: 1_000_000n, dayBudgetMicro: null, notifyAboveMicro: null });
    const first = await taskRow();
    await save({
      taskBudgetMicro: 1_000_000n,
      dayBudgetMicro: 5_000_000n,
      notifyAboveMicro: 50_000n,
    });
    expect(await taskRow()).toEqual(first);

    // A new cap is a new task.
    await save({
      taskBudgetMicro: 2_000_000n,
      dayBudgetMicro: 5_000_000n,
      notifyAboveMicro: 50_000n,
    });
    const second = await taskRow();
    expect(second?.id).not.toBe(first?.id);
    const [agent] = (await loadWallet(db, orgId)).agents;
    expect(agent).toMatchObject({ taskBudgetMicro: 2_000_000n, dayBudgetMicro: 5_000_000n });
  });

  it("revokes a key so it stops authenticating", async () => {
    const { orgId, agentId } = await setup();
    const key = await createAgentKey(db, { orgId, agentId });
    expect((await authenticateKey(db, key.rawKey)).ok).toBe(true);
    expect(await revokeAgentKey(db, { orgId, keyId: key.id })).toBe(true);
    expect((await authenticateKey(db, key.rawKey)).ok).toBe(false);
  });

  it("won't touch another org's agent or key", async () => {
    const mine = await setup();
    const theirs = await setup();
    const key = await createAgentKey(db, theirs);

    await expect(
      createAgentKey(db, { orgId: mine.orgId, agentId: theirs.agentId }),
    ).rejects.toMatchObject({
      code: "agent_not_found",
    });
    await expect(
      setAgentLimits(db, {
        orgId: mine.orgId,
        agentId: theirs.agentId,
        limits: { taskBudgetMicro: 1n, dayBudgetMicro: null, notifyAboveMicro: null },
      }),
    ).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(revokeAgentKey(db, { orgId: mine.orgId, keyId: key.id })).rejects.toMatchObject({
      code: "key_not_found",
    });
    expect((await authenticateKey(db, key.rawKey)).ok).toBe(true);
  });
});
