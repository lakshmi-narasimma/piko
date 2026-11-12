/**
 * The kill switch (docs/DESIGN.md section 9, step 1; BACKLOG P5-07): an org admin freezes
 * or unfreezes one agent, one team or the whole org. A frozen scope gets 423 `agent_frozen`
 * on every new payment and on every Receipt it already holds (lib/gateway, lib/facilitator).
 *
 * Like the rest of lib/org, every change takes the signed-in principal and works only inside
 * that principal's org: an id from the browser is only ever looked up within it. Each change
 * is idempotent (freezing a frozen scope changes nothing) and writes exactly one alert.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { agents, alerts, orgs, teams } from "../db/schema";
import { OrgError, type Actor } from "./index";

/** The alert type a freeze writes. lib/alerts/types labels it "Frozen" (tested). */
export const FROZEN_ALERT_TYPE = "frozen";
/** The alert type an unfreeze writes, labelled "Unfrozen". */
export const UNFROZEN_ALERT_TYPE = "unfrozen";

export type FreezeTarget = { scope: "org" } | { scope: "team" | "agent"; id: unknown };

export interface FreezeResult {
  /** False when the scope was already in the requested state: nothing changed. */
  changed: boolean;
  /** The agent's or team's name, or the org's. */
  name: string;
}

function requireAdmin(actor: Actor): string {
  if (actor.role !== "admin") {
    throw new OrgError("forbidden", "Only an org admin can use the kill switch.");
  }
  return actor.org.id;
}

const NOT_FOUND = {
  agent: () => new OrgError("agent_not_found", "No such agent."),
  team: () => new OrgError("team_not_found", "No such team."),
} as const;

function parseId(scope: "team" | "agent", id: unknown): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw NOT_FOUND[scope]();
  return parsed.data;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Sets or clears one row's `frozen_at`, matching only a row in the org whose state changes.
 * Returns `changedName` when this call changed the row, and `existingName` whenever the row
 * exists in the org.
 */
async function flip(
  tx: Tx,
  scope: FreezeTarget["scope"],
  id: string,
  orgId: string,
  frozen: boolean,
): Promise<{ changedName: string | null; existingName: string | null }> {
  const frozenAt = frozen ? sql`now()` : null;
  const state = <T extends typeof orgs.frozenAt | typeof teams.frozenAt | typeof agents.frozenAt>(
    column: T,
  ) => (frozen ? isNull(column) : isNotNull(column));

  let changed: { name: string }[];
  let existing: { name: string }[];
  if (scope === "org") {
    const where = eq(orgs.id, orgId);
    changed = await tx
      .update(orgs)
      .set({ frozenAt })
      .where(and(where, state(orgs.frozenAt)))
      .returning({ name: orgs.name });
    existing = changed.length
      ? changed
      : await tx.select({ name: orgs.name }).from(orgs).where(where);
  } else if (scope === "team") {
    const where = and(eq(teams.id, id), eq(teams.orgId, orgId));
    changed = await tx
      .update(teams)
      .set({ frozenAt })
      .where(and(where, state(teams.frozenAt)))
      .returning({ name: teams.name });
    existing = changed.length
      ? changed
      : await tx.select({ name: teams.name }).from(teams).where(where);
  } else {
    const where = and(eq(agents.id, id), eq(agents.orgId, orgId));
    changed = await tx
      .update(agents)
      .set({ frozenAt })
      .where(and(where, state(agents.frozenAt)))
      .returning({ name: agents.name });
    existing = changed.length
      ? changed
      : await tx.select({ name: agents.name }).from(agents).where(where);
  }
  return { changedName: changed[0]?.name ?? null, existingName: existing[0]?.name ?? null };
}

function describe(scope: FreezeTarget["scope"], name: string): string {
  if (scope === "org") return `the whole org (${name})`;
  return scope === "team" ? `the ${name} team` : name;
}

/**
 * Turns the kill switch on (`frozen: true`) or off for an agent, a team or the actor's org.
 * The update and its alert commit together, and the update only matches a row whose state
 * changes, so concurrent clicks write one alert between them.
 *
 * @throws OrgError `forbidden` for a non-admin, `agent_not_found` or `team_not_found` for an
 *   id that isn't in the actor's org.
 */
export async function setFrozen(
  db: Db,
  actor: Actor,
  target: FreezeTarget,
  frozen: boolean,
): Promise<FreezeResult> {
  const orgId = requireAdmin(actor);
  const { scope } = target;
  const id = target.scope === "org" ? orgId : parseId(target.scope, target.id);

  return db.transaction(async (tx) => {
    const { changedName, existingName } = await flip(tx, scope, id, orgId, frozen);
    if (existingName === null) {
      // The actor's own org always exists, so only a team or agent id can miss.
      throw scope === "org" ? new OrgError("forbidden", "No such org.") : NOT_FOUND[scope]();
    }
    if (changedName === null) return { changed: false, name: existingName };

    await tx.insert(alerts).values({
      orgId,
      agentId: scope === "agent" ? id : null,
      type: frozen ? FROZEN_ALERT_TYPE : UNFROZEN_ALERT_TYPE,
      message: frozen
        ? `Kill switch on: an admin froze ${describe(scope, changedName)}.`
        : `Kill switch off: an admin unfroze ${describe(scope, changedName)}.`,
    });
    return { changed: true, name: changedName };
  });
}

/** Whether the org-wide kill switch is on. */
export async function isOrgFrozen(db: Db, orgId: string): Promise<boolean> {
  const [row] = await db.select({ frozenAt: orgs.frozenAt }).from(orgs).where(eq(orgs.id, orgId));
  return row?.frozenAt != null;
}
