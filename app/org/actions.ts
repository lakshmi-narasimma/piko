"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createAgent, createTeam, moveAgent, OrgError, type Actor } from "@/lib/org";

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
