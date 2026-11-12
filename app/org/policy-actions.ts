"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { OrgError, type Actor } from "@/lib/org";
import { compilePolicy, confirmCompiledPolicy } from "@/lib/policy/compile";

/** What the Policies section shows after Compile or Confirm. */
export interface CompileState {
  /** A compiled rule waiting for Confirm. Nothing is saved or enforced yet. */
  preview?: {
    sourceText: string;
    /** The checked document as JSON. Confirm sends it back and the server checks it again. */
    document: string;
    readable: string[];
    warnings: string[];
  };
  error?: string;
  message?: string;
}

/** The signed-in Org console user. The org always comes from the session, never the form. */
async function actor(): Promise<Actor> {
  const principal = await getPrincipal();
  if (!principal || principal.area !== "org") {
    throw new OrgError("forbidden", "Sign in to the Org console.");
  }
  return principal;
}

/** Plain English to a rule for the admin to confirm. Saves nothing. */
export async function compilePolicyAction(_: CompileState, form: FormData): Promise<CompileState> {
  const sourceText = String(form.get("text") ?? "").trim();
  try {
    const result = await compilePolicy(getDb(), await actor(), sourceText);
    if (!result.ok) return { error: result.message };
    return {
      preview: {
        sourceText,
        document: JSON.stringify(result.document),
        readable: result.readable,
        warnings: result.warnings,
      },
    };
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
}

/**
 * Confirm. The browser sends the compiled document back, so the server checks it again
 * (schema and the team or Agent in the session's org) before saving it as enforced.
 */
export async function confirmPolicyAction(_: CompileState, form: FormData): Promise<CompileState> {
  let document: unknown;
  try {
    document = JSON.parse(String(form.get("document") ?? ""));
  } catch {
    return { error: "That rule wasn't readable. Compile it again." };
  }
  try {
    const result = await confirmCompiledPolicy(getDb(), await actor(), {
      sourceText: form.get("sourceText"),
      document,
    });
    if (!result.ok) return { error: result.message };
    revalidatePath("/org");
    return {
      message: result.alreadyConfirmed
        ? "This rule was already confirmed and is enforced."
        : "Confirmed. This rule is now enforced.",
    };
  } catch (error) {
    if (error instanceof OrgError) return { error: error.message };
    throw error;
  }
}
