import { Suspense } from "react";
import { CallFeed } from "@/components/call-feed";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatUsd } from "@/lib/money";
import { loadWallet } from "@/lib/wallet";
import { AgentPanel } from "./agent-panel";
import { TopupButton } from "./topup-button";

export const metadata = { title: "Wallet · Piko" };

/** An amount as the text of a dollar input: "0.05", no symbol or separators. */
const dollars = (micro: bigint | null) =>
  micro === null ? "" : formatUsd(micro).replace(/[$,]/g, "");

// Reads the session cookie and the database, so it renders at request time inside Suspense.
async function WalletContent() {
  const { org } = await requirePrincipal("wallet");
  const wallet = await loadWallet(getDb(), org.id);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-muted">{org.name}</p>
      </header>

      <section aria-label="Balance" className="grid gap-6 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-5">
          <span className="text-sm text-muted">Balance</span>
          <span className="text-4xl font-semibold tabular-nums">
            {formatUsd(wallet.balanceMicro)}
          </span>
        </div>
        <div className="rounded-xl border border-line p-5">
          <h2 className="mb-3 text-lg font-medium">Top up with PayPal</h2>
          <TopupButton clientId={getEnv().NEXT_PUBLIC_PAYPAL_CLIENT_ID} />
        </div>
      </section>

      <section aria-label="Agents" className="flex flex-col gap-4">
        <h2 className="text-xl font-medium">Agents, budgets and keys</h2>
        {wallet.agents.length === 0 && <p className="text-muted">No agents yet.</p>}
        {wallet.agents.map((agent) => (
          <AgentPanel
            key={agent.id}
            agent={{
              id: agent.id,
              name: agent.name,
              task: dollars(agent.taskBudgetMicro),
              day: dollars(agent.dayBudgetMicro),
              notify: dollars(agent.notifyAboveMicro),
              keys: agent.keys.map((key) => ({
                id: key.id,
                prefix: key.prefix,
                created: key.createdAt.toISOString().slice(0, 10),
                revoked: key.revokedAt !== null,
              })),
            }}
          />
        ))}
      </section>

      <CallFeed side="buyer" />
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <WalletContent />
    </Suspense>
  );
}
