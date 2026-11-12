"use server";

import { revalidatePath } from "next/cache";
import { ApprovalError, decideApproval } from "@/lib/approvals";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { ActionState } from "./actions";

/**
 * Approves or denies one pending Approval. The org comes from the session; lib/approvals
 * refuses anyone who isn't an admin of that org.
 */
export async function decideApprovalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const principal = await getPrincipal();
  if (!principal || principal.area !== "org") return { error: "Sign in to the Org console." };
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "denied") return { error: "Approve or deny." };

  try {
    await decideApproval(getDb(), principal, String(form.get("id") ?? ""), decision);
  } catch (error) {
    if (error instanceof ApprovalError) return { error: error.message };
    throw error;
  }
  revalidatePath("/org");
  return {
    message:
      decision === "approved"
        ? "Approved. The agent's next poll gets its receipt."
        : "Denied. The agent's payment is blocked.",
  };
}
