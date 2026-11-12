import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { agents, alerts, orgs, teams } from "../db/schema";
import { createKey, authenticateKey, currentFrozenScope } from "../keys";
import {
  FROZEN_ALERT_TYPE,
  isOrgFrozen,
  setFrozen,
  UNFROZEN_ALERT_TYPE,
  type FreezeTarget,
} from "./freeze";
import { OrgError, type Actor } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("kill switch: freeze and unfreeze", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url!, { max: 5 });
  });
  afterAll(async () => {
    await db.$client.end();
  });

  /** A company org with a Marketing team of two agents and one agent in no team. */
  async function newOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Acme", slug: `acme-${randomUUID()}`, kind: "company", billing: "invoiced" })
      .returning({ id: orgs.id });
    const orgId = org!.id;
    const [team] = await db
      .insert(teams)
      .values({ orgId, name: "Marketing" })
      .returning({ id: teams.id });
    const made = await db
      .insert(agents)
      .values([
        { orgId, teamId: team!.id, name: "campaign-researcher" },
        { orgId, teamId: team!.id, name: "competitor-watch" },
        { orgId, teamId: null, name: "loner" },
      ])
      .returning({ id: agents.id, name: agents.name });
    const keys = await Promise.all(made.map((agent) => createKey(db, agent.id)));
    const admin: Actor = { org: { id: orgId }, role: "admin" };
    const member: Actor = { org: { id: orgId }, role: "member" };
    return {
      orgId,
      teamId: team!.id,
      agentIds: made.map((agent) => agent.id),
      keys: keys.map((key) => key.rawKey),
      admin,
      member,
    };
  }

  const alertsOf = (orgId: string) =>
    db.select().from(alerts).where(eq(alerts.orgId, orgId)).orderBy(asc(alerts.createdAt));
  const scopesOf = (keys: string[]) =>
    Promise.all(
      keys.map(async (key) => {
        const auth = await authenticateKey(db, key);
        return auth.ok ? auth.frozenScope : "invalid";
      }),
    );

  it("freezes and unfreezes one agent, writing one alert each way", async () => {
    const org = await newOrg();
    const target: FreezeTarget = { scope: "agent", id: org.agentIds[0] };

    await expect(setFrozen(db, org.admin, target, true)).resolves.toEqual({
      changed: true,
      name: "campaign-researcher",
    });
    expect(await scopesOf(org.keys)).toEqual(["agent", null, null]);
    expect(await currentFrozenScope(db, org.agentIds[0]!)).toBe("agent");

    // Idempotent: a second freeze changes nothing and writes no alert.
    await expect(setFrozen(db, org.admin, target, true)).resolves.toMatchObject({
      changed: false,
    });

    await expect(setFrozen(db, org.admin, target, false)).resolves.toMatchObject({
      changed: true,
    });
    await expect(setFrozen(db, org.admin, target, false)).resolves.toMatchObject({
      changed: false,
    });
    expect(await scopesOf(org.keys)).toEqual([null, null, null]);

    const written = await alertsOf(org.orgId);
    expect(written.map((alert) => [alert.type, alert.agentId])).toEqual([
      [FROZEN_ALERT_TYPE, org.agentIds[0]],
      [UNFROZEN_ALERT_TYPE, org.agentIds[0]],
    ]);
    expect(written[0]!.message).toBe("Kill switch on: an admin froze campaign-researcher.");
  });

  it("freezing a team blocks both its agents, and unfreezing restores them", async () => {
    const org = await newOrg();
    const target: FreezeTarget = { scope: "team", id: org.teamId };

    await setFrozen(db, org.admin, target, true);
    expect(await scopesOf(org.keys)).toEqual(["team", "team", null]);

    await setFrozen(db, org.admin, target, false);
    expect(await scopesOf(org.keys)).toEqual([null, null, null]);

    const written = await alertsOf(org.orgId);
    expect(written.map((alert) => [alert.type, alert.agentId, alert.message])).toEqual([
      [FROZEN_ALERT_TYPE, null, "Kill switch on: an admin froze the Marketing team."],
      [UNFROZEN_ALERT_TYPE, null, "Kill switch off: an admin unfroze the Marketing team."],
    ]);
  });

  it("an org-wide freeze blocks every agent of that org and no other org's", async () => {
    const org = await newOrg();
    const other = await newOrg();

    await setFrozen(db, org.admin, { scope: "org" }, true);
    expect(await scopesOf(org.keys)).toEqual(["org", "org", "org"]);
    expect(await scopesOf(other.keys)).toEqual([null, null, null]);
    expect(await isOrgFrozen(db, org.orgId)).toBe(true);
    expect(await isOrgFrozen(db, other.orgId)).toBe(false);

    // The widest switch wins while several are on.
    await setFrozen(db, org.admin, { scope: "team", id: org.teamId }, true);
    expect(await scopesOf(org.keys)).toEqual(["org", "org", "org"]);
    await setFrozen(db, org.admin, { scope: "org" }, false);
    expect(await scopesOf(org.keys)).toEqual(["team", "team", null]);

    const types = (await alertsOf(org.orgId)).map((alert) => alert.type);
    expect(types).toEqual([FROZEN_ALERT_TYPE, FROZEN_ALERT_TYPE, UNFROZEN_ALERT_TYPE]);
    expect(await alertsOf(other.orgId)).toEqual([]);
  });

  it("refuses a member, changing nothing", async () => {
    const org = await newOrg();
    for (const target of [
      { scope: "org" },
      { scope: "team", id: org.teamId },
      { scope: "agent", id: org.agentIds[0] },
    ] satisfies FreezeTarget[]) {
      await expect(setFrozen(db, org.member, target, true)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    expect(await scopesOf(org.keys)).toEqual([null, null, null]);
    expect(await alertsOf(org.orgId)).toEqual([]);
  });

  it("can't reach another org's team or agent, or a made-up id", async () => {
    const org = await newOrg();
    const victim = await newOrg();

    await expect(
      setFrozen(db, org.admin, { scope: "team", id: victim.teamId }, true),
    ).rejects.toMatchObject({ code: "team_not_found" });
    await expect(
      setFrozen(db, org.admin, { scope: "agent", id: victim.agentIds[0] }, true),
    ).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(
      setFrozen(db, org.admin, { scope: "agent", id: "not-a-uuid" }, true),
    ).rejects.toBeInstanceOf(OrgError);
    await expect(
      setFrozen(db, org.admin, { scope: "team", id: randomUUID() }, true),
    ).rejects.toMatchObject({ code: "team_not_found" });

    expect(await scopesOf(victim.keys)).toEqual([null, null, null]);
    expect(await alertsOf(victim.orgId)).toEqual([]);
    expect(await alertsOf(org.orgId)).toEqual([]);
  });

  it("writes one alert when the same freeze is clicked many times at once", async () => {
    const org = await newOrg();
    const target: FreezeTarget = { scope: "team", id: org.teamId };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => setFrozen(db, org.admin, target, true)),
    );
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await alertsOf(org.orgId)).toHaveLength(1);
  });
});
