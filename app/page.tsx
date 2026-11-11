import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PersonaButtons } from "@/app/login/persona-buttons";
import { PERSONAS } from "@/lib/auth";
import { getEnv } from "@/lib/env";

const door =
  "flex flex-col gap-1 rounded-xl border border-line bg-surface p-5 hover:border-brand focus-visible:outline-2 focus-visible:outline-accent";

// DEMO_MODE is read at request time, so flipping it needs no rebuild.
async function PersonaSection() {
  await connection();
  if (!getEnv().DEMO_MODE) return null;
  return (
    <section aria-labelledby="personas" className="flex flex-col gap-3">
      <h2 id="personas" className="text-xl font-medium">
        Try it as someone
      </h2>
      <p className="text-muted">One click, no password. Demo mode only.</p>
      <PersonaButtons personas={PERSONAS} />
    </section>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12 sm:py-20">
      <section className="flex max-w-2xl flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          PayPal is how AI agents pay, and get paid.
        </h1>
        <p className="text-lg text-muted">
          One wallet your team can control, and one gateway that turns any API or MCP tool into
          per-call revenue paid out to PayPal.
        </p>
      </section>

      <section aria-label="Choose your side" className="grid gap-4 sm:grid-cols-2">
        <Link href="/wallet" className={door}>
          <span className="text-lg font-medium">I&rsquo;m buying</span>
          <span className="text-muted">
            Fund a wallet from PayPal, set budgets and policies, and let agents pay per call.
          </span>
        </Link>
        <Link href="/seller" className={door}>
          <span className="text-lg font-medium">I&rsquo;m selling</span>
          <span className="text-muted">
            Put an API or MCP tool behind the gateway, price it per call and get paid out.
          </span>
        </Link>
      </section>

      <Suspense>
        <PersonaSection />
      </Suspense>
    </main>
  );
}
