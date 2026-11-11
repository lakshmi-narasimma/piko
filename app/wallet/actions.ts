"use server";

import { revalidatePath } from "next/cache";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { parseUsd } from "@/lib/money";
import { createAgentKey, revokeAgentKey, setAgentLimits, WalletError } from "@/lib/wallet";

export interface ActionState {
  message?: string;
  error?: string;
  /** A new Key's raw value. Shown once, then gone. */
  rawKey?: string;
}

async function adminOrgId(): Promise<string> {
  const principal = await getPrincipal();
  if (!principal || principal.role !== "admin")
    throw new WalletError("agent_not_found", "Sign in.");
  return principal.org.id;
}

/** Blank clears the limit. */
function dollars(form: FormData, name: string): bigint | null {
  const text = String(form.get(name) ?? "").trim();
  return text === "" ? null : parseUsd(text);
}

export async function saveLimits(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await setAgentLimits(getDb(), {
      orgId: await adminOrgId(),
      agentId: String(form.get("agentId")),
      limits: {
        taskBudgetMicro: dollars(form, "task"),
        dayBudgetMicro: dollars(form, "day"),
        notifyAboveMicro: dollars(form, "notify"),
      },
    });
  } catch (error) {
    if (error instanceof RangeError) return { error: "Enter amounts in dollars, like 1.00." };
    if (error instanceof WalletError) return { error: error.message };
    throw error;
  }
  revalidatePath("/wallet");
  return { message: "Saved." };
}

export async function createKeyAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const key = await createAgentKey(getDb(), {
      orgId: await adminOrgId(),
      agentId: String(form.get("agentId")),
    });
    revalidatePath("/wallet");
    return { rawKey: key.rawKey };
  } catch (error) {
    if (error instanceof WalletError) return { error: error.message };
    throw error;
  }
}

export async function revokeKeyAction(form: FormData): Promise<void> {
  try {
    await revokeAgentKey(getDb(), {
      orgId: await adminOrgId(),
      keyId: String(form.get("keyId")),
    });
  } catch (error) {
    if (!(error instanceof WalletError)) throw error;
  }
  revalidatePath("/wallet");
}
