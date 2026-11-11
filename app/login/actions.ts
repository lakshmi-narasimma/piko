"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { AREA_PATH, endSession, startSession } from "@/lib/auth";
import { findByPassword, findPersona, isPersona } from "@/lib/auth/accounts";
import { getDb } from "@/lib/db/client";
import { getEnv } from "@/lib/env";

export interface LoginState {
  error?: string;
}

/** One-click persona login. Only exists while DEMO_MODE=true. */
export async function loginAsPersona(email: string): Promise<LoginState> {
  if (!getEnv().DEMO_MODE) return { error: "The persona switcher is turned off." };
  if (!isPersona(email)) return { error: "Unknown persona." };
  const principal = await findPersona(getDb(), email);
  if (!principal) {
    return { error: "That persona isn't in the database yet. Run `npm run seed`." };
  }
  await startSession(principal);
  redirect(AREA_PATH[principal.area]);
}

const credentials = z.object({ email: z.email(), password: z.string().min(1) });

export async function loginWithPassword(_: LoginState, form: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse({
    email: String(form.get("email") ?? "").trim(),
    password: String(form.get("password") ?? ""),
  });
  if (!parsed.success) return { error: "Enter your email and password." };
  const principal = await findByPassword(getDb(), parsed.data.email, parsed.data.password);
  if (!principal) return { error: "Wrong email or password." };
  await startSession(principal);
  redirect(AREA_PATH[principal.area]);
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}
