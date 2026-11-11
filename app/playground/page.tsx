import { Suspense } from "react";
import { requirePrincipal } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { Playground } from "./playground";

export const metadata = { title: "Playground · Piko" };

// Reads the session cookie, so it renders at request time inside a Suspense boundary.
async function PlaygroundContent() {
  const { org } = await requirePrincipal("wallet");
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Agent playground</h1>
        <p className="text-muted">
          Watch an agent spend {org.name}&rsquo;s wallet, one paid API call at a time.
        </p>
      </header>
      <Playground paypalClientId={getEnv().NEXT_PUBLIC_PAYPAL_CLIENT_ID} />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <PlaygroundContent />
    </Suspense>
  );
}
