import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createSeller, stubGatewayEnv } from "@/test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, ledgerEntries, orgs, teams } from "../db/schema";
import { postCall, refundCall } from "../ledger";
import { ACME_TEMP_ORG_BUDGET_MICRO, seedAcmeTemp } from "../seed/acme-temp";
import { createAgent, createTeam, loadOrgTree, moveAgent, OrgError, type Actor } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("org console tree", () => {
  let db: Db;
  let acme: Actor;
  let endpointId: string;
  let sellerOrgId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const { orgId } = await db.transaction((tx) => seedAcmeTemp(tx));
    acme = { org: { id: orgId }, role: "admin" };
    const seller = await createSeller(db, "http://localhost/unused");
    endpointId = seller.endpointId;
    sellerOrgId = seller.orgId;
  });
  beforeEach(() => {
    stubGatewayEnv();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  async function newOrg(): Promise<Actor> {
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Other",
        slug: `other-${randomUUID()}`,
        kind: "company",
        billing: "invoiced",
      })
      .returning({ id: orgs.id });
    return { org: { id: org!.id }, role: "admin" };
  }

  async function agentId(orgId: string, name: string): Promise<string> {
    const tree = await loadOrgTree(db, orgId);
    const all = [...tree.teams.flatMap((team) => team.agents), ...tree.unassigned];
    return all.find((agent) => agent.name === name)!.id;
  }

  /** A paid Call posted to the Ledger, as the pay pipeline would. */
  async function paidCall(orgId: string, agent: string, priceMicro: bigint, simulated = false) {
    const [call] = await db
      .insert(calls)
      .values({
        agentId: agent,
        buyerOrgId: orgId,
        endpointId,
        amountMicro: priceMicro,
        status: "paid",
        simulated,
      })
      .returning({ id: calls.id });
    await postCall(db, { callId: call!.id, buyerOrgId: orgId, sellerOrgId, priceMicro });
    return call!.id;
  }

  it("shows Acme's 3 teams and 5 agents from the temporary seed, with their budgets", async () => {
    const tree = await loadOrgTree(db, acme.org.id);
    expect(tree.teams.map((team) => [team.name, team.agents.map((agent) => agent.name)])).toEqual([
      ["Marketing", ["campaign-researcher", "competitor-watch"]],
      ["Support", ["ticket-triage"]],
      ["Data", ["catalog-sync", "loop-bot"]],
    ]);
    expect(tree.unassigned).toEqual([]);
    expect(tree.budgets).toEqual([
      { period: "month", maxMicro: ACME_TEMP_ORG_BUDGET_MICRO, category: null },
    ]);
    expect(tree.teams.map((team) => team.budgets)).toEqual([
      [{ period: "month", maxMicro: 50_000_000n, category: null }],
      [{ period: "month", maxMicro: 80_000_000n, category: null }],
      [{ period: "month", maxMicro: 150_000_000n, category: null }],
    ]);
  });

  it("sums this month's spend per agent, team and org, net of refunds, with the simulated part", async () => {
    const org = await newOrg();
    const team = await createTeam(db, org, { name: "Research" });
    const a = await createAgent(db, org, { name: "a-bot", teamId: team.id });
    const b = await createAgent(db, org, { name: "b-bot", teamId: null });

    await paidCall(org.org.id, a.id, 10_000n);
    await paidCall(org.org.id, a.id, 2_000n, true);
    const refunded = await paidCall(org.org.id, a.id, 5_000n);
    await refundCall(db, refunded);
    await paidCall(org.org.id, b.id, 7_000n);

    // Last month's Call doesn't count toward this month.
    const [old] = await db
      .insert(calls)
      .values({
        agentId: a.id,
        buyerOrgId: org.org.id,
        endpointId,
        amountMicro: 1n,
        status: "paid",
      })
      .returning({ id: calls.id });
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId: org.org.id,
      amountMicro: -99_000n,
      reason: "call",
      refId: old!.id,
      createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
    });

    const tree = await loadOrgTree(db, org.org.id);
    expect(tree.teams[0]).toMatchObject({ spentMicro: 12_000n, simulatedMicro: 2_000n });
    expect(tree.teams[0]!.agents[0]).toMatchObject({ name: "a-bot", spentMicro: 12_000n });
    expect(tree.unassigned).toMatchObject([{ name: "b-bot", spentMicro: 7_000n }]);
    expect(tree).toMatchObject({ spentMicro: 19_000n, simulatedMicro: 2_000n });
  });

  it("creates a team and an agent in it", async () => {
    const team = await createTeam(db, acme, { name: "  Finance " });
    await createAgent(db, acme, { name: "invoice-checker", teamId: team.id });
    const tree = await loadOrgTree(db, acme.org.id);
    expect(tree.teams.find((t) => t.id === team.id)).toMatchObject({
      name: "Finance",
      agents: [{ name: "invoice-checker", teamId: team.id }],
    });
  });

  it("refuses duplicate and invalid names", async () => {
    await expect(createTeam(db, acme, { name: "Marketing" })).rejects.toMatchObject({
      code: "name_taken",
    });
    await expect(createTeam(db, acme, { name: "  " })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(createAgent(db, acme, { name: "loop-bot", teamId: null })).rejects.toMatchObject({
      code: "name_taken",
    });
    await expect(createAgent(db, acme, { name: "Has Spaces", teamId: null })).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    await expect(createAgent(db, acme, { name: "ok-bot", teamId: "nope" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("moves an agent to another team and out of every team", async () => {
    const loopBot = await agentId(acme.org.id, "loop-bot");
    const support = (await loadOrgTree(db, acme.org.id)).teams.find((t) => t.name === "Support")!;

    await moveAgent(db, acme, { agentId: loopBot, teamId: support.id });
    let tree = await loadOrgTree(db, acme.org.id);
    expect(tree.teams.find((t) => t.name === "Support")!.agents.map((a) => a.name)).toEqual([
      "ticket-triage",
      "loop-bot",
    ]);
    expect(tree.teams.find((t) => t.name === "Data")!.agents.map((a) => a.name)).toEqual([
      "catalog-sync",
    ]);

    await moveAgent(db, acme, { agentId: loopBot, teamId: null });
    tree = await loadOrgTree(db, acme.org.id);
    expect(tree.unassigned.map((a) => a.name)).toEqual(["loop-bot"]);

    const data = tree.teams.find((t) => t.name === "Data")!;
    await moveAgent(db, acme, { agentId: loopBot, teamId: data.id });
  });

  it("refuses a member who isn't an admin", async () => {
    const member: Actor = { org: acme.org, role: "member" };
    const loopBot = await agentId(acme.org.id, "loop-bot");
    await expect(createTeam(db, member, { name: "Sneaky" })).rejects.toBeInstanceOf(OrgError);
    await expect(createTeam(db, member, { name: "Sneaky" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(createAgent(db, member, { name: "sneaky", teamId: null })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(moveAgent(db, member, { agentId: loopBot, teamId: null })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await db.select().from(teams).where(eq(teams.name, "Sneaky"))).length).toBe(0);
  });

  it("refuses another org's admin touching Acme's agents", async () => {
    const other = await newOrg();
    const loopBot = await agentId(acme.org.id, "loop-bot");
    await expect(moveAgent(db, other, { agentId: loopBot, teamId: null })).rejects.toMatchObject({
      code: "agent_not_found",
    });
    const [row] = await db.select().from(agents).where(eq(agents.id, loopBot));
    expect(row!.teamId).not.toBeNull();
    expect((await loadOrgTree(db, other.org.id)).teams).toEqual([]);
  });

  it("refuses moving an agent into, or creating one in, another org's team", async () => {
    const other = await newOrg();
    const theirTeam = await createTeam(db, other, { name: "Theirs" });
    const loopBot = await agentId(acme.org.id, "loop-bot");

    await expect(
      moveAgent(db, acme, { agentId: loopBot, teamId: theirTeam.id }),
    ).rejects.toMatchObject({ code: "team_not_found" });
    await expect(
      createAgent(db, acme, { name: "cross-bot", teamId: theirTeam.id }),
    ).rejects.toMatchObject({ code: "team_not_found" });

    // The database refuses it too, even if the check above were skipped.
    await expect(
      db.update(agents).set({ teamId: theirTeam.id }).where(eq(agents.id, loopBot)),
    ).rejects.toThrow();
  });
});
