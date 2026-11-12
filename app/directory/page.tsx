import Link from "next/link";
import { Suspense } from "react";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { BROWSE_LIMIT, browseDirectory, lowestPriceMicro } from "@/lib/directory";
import { getLlm } from "@/lib/llm";
import { formatUsd } from "@/lib/money";
import { KindBadges, Rating } from "./listing-bits";

export const metadata = { title: "Directory · Piko" };

/** `?q=` as one trimmed string, whatever the URL holds. */
function queryOf(q: string | string[] | undefined): string {
  return (Array.isArray(q) ? q[0] : q)?.trim().slice(0, 200) ?? "";
}

// Reads the session cookie, the URL and the database, so it renders at request time inside Suspense.
async function DirectoryContent({ searchParams }: Pick<PageProps<"/directory">, "searchParams">) {
  const { org } = await requirePrincipal();
  const query = queryOf((await searchParams).q);
  const { mode, results } = await browseDirectory(getDb(), getLlm(), {
    query,
    buyerOrgId: org.id,
  });

  return (
    <>
      <form role="search" action="/directory" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="directory-q" className="sr-only">
          Search APIs and MCP tools
        </label>
        <input
          id="directory-q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Try “product prices” or “reviews”"
          className="min-w-0 flex-1 rounded-md border border-line bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent"
        />
        <button className="rounded-md bg-brand px-4 py-2 font-medium text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          Search
        </button>
      </form>

      <p className="text-sm text-muted" aria-live="polite">
        {mode === "all"
          ? `${results.length < BROWSE_LIMIT ? "All" : "The top"} ${results.length} listings, best rated first.`
          : `${results.length} ${results.length === 1 ? "result" : "results"} for “${query}”.`}
        {mode === "keyword" && (
          <span className="ml-1">The AI search is busy, so these are keyword results.</span>
        )}
      </p>

      {results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-center">
          <p className="font-medium">Nothing matches that yet.</p>
          <p className="mt-1 text-sm text-muted">
            Try other words, or{" "}
            <Link href="/directory" className="text-accent underline">
              browse every listing
            </Link>
            .
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {results.map((listing) => {
            const lowest = lowestPriceMicro(listing);
            return (
              <li key={listing.id}>
                <Link
                  href={`/directory/${listing.seller.slug}/${listing.slug}`}
                  className="flex h-full flex-col gap-3 rounded-xl border border-line p-5 hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-lg font-medium">{listing.name}</h2>
                    <KindBadges kind={listing.kind} />
                  </div>
                  <p className="line-clamp-3 text-sm text-muted">{listing.description}</p>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
                    <span>
                      {lowest === null ? (
                        "No endpoints"
                      ) : (
                        <>
                          {listing.endpoints.length > 1 && "from "}
                          <span className="font-semibold tabular-nums">
                            {formatUsd(lowest)}
                          </span>{" "}
                          per call
                        </>
                      )}
                    </span>
                    <Rating rating={listing.rating} />
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted">
                    <span>by {listing.seller.name}</span>
                    {listing.category && <span>· {listing.category}</span>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export default function Page({ searchParams }: PageProps<"/directory">) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Directory</h1>
        <p className="text-muted">Every API and MCP tool you can pay for per call through Piko.</p>
      </header>
      <Suspense fallback={<p className="text-muted">Searching…</p>}>
        <DirectoryContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
