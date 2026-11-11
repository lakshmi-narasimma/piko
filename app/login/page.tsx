import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AREA_PATH, getPrincipal, PERSONAS } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { PasswordForm } from "./password-form";
import { PersonaButtons } from "./persona-buttons";

export const metadata = { title: "Sign in · Piko" };

// Reads the session cookie and DEMO_MODE, so it renders at request time inside a Suspense boundary.
async function LoginContent() {
  const principal = await getPrincipal();
  if (principal) redirect(AREA_PATH[principal.area]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">
        {getEnv().DEMO_MODE ? "Pick a persona" : "Sign in"}
      </h1>
      {getEnv().DEMO_MODE ? <PersonaButtons personas={PERSONAS} /> : <PasswordForm />}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
