import Link from "next/link";
import { Suspense } from "react";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadSpendRows, SPEND_ROW_LIMIT, spendRange } from "@/lib/org/spend";
import { SpendGrid, type GridRow } from "./spend-grid";

export const metadata = { title: "Spend · Org console · Piko" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Reads the session cookie, the query and the database, so it renders at request time.
async function SpendContent({ searchParams }: { searchParams: SearchParams }) {
  const principal = await requirePrincipal("org");
  const range = spendRange(await searchParams);

  if (principal.role !== "admin") {
    return (
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Spend</h1>
        <p className="text-muted">Only an org admin can see the org&apos;s spend.</p>
      </main>
    );
  }

  const { rows, truncated } = await loadSpendRows(getDb(), principal, range);
  // Amounts cross to the browser as strings of micro-USD, so no float ever holds one.
  const gridRows: GridRow[] = rows.map((row) => ({
    callId: row.callId,
    at: row.at.toISOString(),
    day: row.day,
    team: row.team ?? "No team",
    agent: row.agent,
    vendor: row.vendor,
    listing: row.listing,
    endpoint: row.endpoint,
    status: row.status,
    priceMicro: row.priceMicro.toString(),
    spentMicro: row.spentMicro.toString(),
    simulated: row.simulated,
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <Link href="/org" className="text-sm text-muted hover:underline">
          ← Org console
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Spend</h1>
        <p className="text-muted">
          Every Call {principal.org.name}&apos;s Agents made, by team, agent, vendor and day. Spend
          is what each Call cost the wallet, net of refunds.
        </p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            type="date"
            name="from"
            defaultValue={range.from}
            className="rounded border border-line bg-background px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input
            type="date"
            name="to"
            defaultValue={range.to}
            className="rounded border border-line bg-background px-2 py-1"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground"
        >
          Show
        </button>
        <span className="text-sm text-muted">Days are UTC. Default is the last 30 days.</span>
      </form>

      {truncated && (
        <p className="text-sm text-muted">
          This range has more than {SPEND_ROW_LIMIT.toLocaleString("en-US")} Calls, so only the
          newest {SPEND_ROW_LIMIT.toLocaleString("en-US")} are shown. Pick a shorter range.
        </p>
      )}

      <SpendGrid rows={gridRows} range={range} />
    </main>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <SpendContent searchParams={searchParams} />
    </Suspense>
  );
}
