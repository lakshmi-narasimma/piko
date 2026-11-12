"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { breakerLimitsFromEnv } from "@/lib/breaker";
import { createAgent, createTeam, moveAgent, OrgError, type Actor } from "@/lib/org";
import { setFrozen, type FreezeResult, type FreezeTarget } from "@/lib/org/freeze";

export interface ActionState {
  message?: string;
  error?: string;
}

/**
 * The signed-in Org console user. The org always comes from the session, never from the
 * form; lib/org refuses anyone who isn't an admin.
 */
async function actor(): Promise<Actor> {
  const principal = await getPrincipal();
  if (!principal || principal.area !== "org") {
    throw new OrgError("forbidden", "Sign in to the Org console.");
  }
  return principal;
}

/** "" in a team picker means "no team". */
function teamField(form: FormData): string | null {
  const value = String(form.get("teamId") ?? "");
  return value === "" ? null : value;
}

async function run(work: () => Promise<unknown>, message: string): Promise<ActionState> {
  try {
    await work();
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
  revalidatePath("/org");
  return { message };
}

export async function createTeamAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(
    async () => createTeam(getDb(), await actor(), { name: form.get("name") }),
    "Team created.",
  );
}

export async function createAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(
    async () =>
      createAgent(getDb(), await actor(), { name: form.get("name"), teamId: teamField(form) }),
    "Agent created.",
  );
}

/**
 * The kill switch. The form names a scope and, for a team or agent, its id; lib/org/freeze
 * looks the id up only inside the signed-in org.
 */
export async function setFrozenAction(_: ActionState, form: FormData): Promise<ActionState> {
  const scope = String(form.get("scope") ?? "");
  const frozen = form.get("frozen") === "true";
  if (scope !== "org" && scope !== "team" && scope !== "agent") {
    return { error: "Pick an agent, a team or the org." };
  }
  const target: FreezeTarget =
    scope === "org" ? { scope } : { scope, id: String(form.get("id") ?? "") };

  let result: FreezeResult | undefined;
  const state = await run(async () => {
    result = await setFrozen(getDb(), await actor(), target, frozen);
  }, "");
  if (state.error || !result) return state;

  const subject = scope === "org" ? "the whole org" : result.name;
  if (!result.changed) {
    return { message: `Already ${frozen ? "frozen" : "unfrozen"}: ${subject}.` };
  }
  if (frozen) return { message: `Froze ${subject}. New payments and held Receipts get 423.` };
  if (scope !== "agent") return { message: `Unfroze ${subject}.` };
  // A breaker trip freezes an agent, and the payments that tripped it are still recent.
  const { windowSeconds } = breakerLimitsFromEnv();
  return {
    message: `Unfroze ${subject}. Its payments from the last ${windowSeconds} s still count toward the circuit breaker, so a burst right away can trip it again.`,
  };
}

export async function moveAgentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return run(
    async () =>
      moveAgent(getDb(), await actor(), {
        agentId: String(form.get("agentId") ?? ""),
        teamId: teamField(form),
      }),
    "Moved.",
  );
}
