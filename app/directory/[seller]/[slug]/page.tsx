import Link from "next/link";
import { Suspense } from "react";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { loadDirectoryListing } from "@/lib/directory";
import { getEnv } from "@/lib/env";
import { CopyButton } from "../../copy-button";
import { KindBadges, Rating } from "../../listing-bits";

export const metadata = { title: "Listing · Piko" };

type Props = PageProps<"/directory/[seller]/[slug]">;

// Reads the session cookie and the database, so it renders at request time inside Suspense.
async function ListingContent({ params }: Pick<Props, "params">) {
  const { org } = await requirePrincipal();
  const { seller, slug } = await params;
  const listing = await loadDirectoryListing(getDb(), {
    sellerSlug: seller,
    slug,
    buyerOrgId: org.id,
  });
  // Said in the page rather than with notFound(): the shell has already streamed by now.
  if (!listing) {
    return (
      <div className="rounded-xl border border-dashed border-line p-8 text-center">
        <h1 className="text-xl font-medium">No listing here</h1>
        <p className="mt-1 text-sm text-muted">
          It may have moved or been removed. Search the directory for it instead.
        </p>
      </div>
    );
  }
  const base = getEnv().APP_BASE_URL.replace(/\/+$/, "");

  return (
    <>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{listing.name}</h1>
          <KindBadges kind={listing.kind} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span>by {listing.seller.name}</span>
          {listing.category && <span>{listing.category}</span>}
          <Rating rating={listing.rating} />
        </div>
        <p className="max-w-prose">{listing.description}</p>
      </header>

      <section aria-labelledby="endpoints-heading" className="flex flex-col gap-3">
        <h2 id="endpoints-heading" className="text-xl font-medium">
          Endpoints
        </h2>
        <p className="text-sm text-muted">
          Prices are what {org.name} pays per call. An agent calls the gateway URL, gets a 402
          Challenge, pays it from its Wallet and calls again with the Receipt.
        </p>
        {listing.endpoints.length === 0 ? (
          <p className="text-muted">This listing has no endpoints yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {listing.endpoints.map((endpoint) => {
              const url = `${base}${endpoint.gatewayPath}`;
              const route = `${endpoint.method} ${endpoint.path}`;
              return (
                <li key={route} className="flex flex-col gap-3 rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="font-mono text-sm">
                      <span className="font-semibold">{endpoint.method}</span> {endpoint.path}
                    </code>
                    <span className="text-sm">
                      <span className="font-semibold tabular-nums">{endpoint.price}</span> per call
                      {endpoint.freeQuota > 0 && (
                        <span className="text-muted">
                          {" "}
                          · first {endpoint.freeQuota.toLocaleString("en-US")} free
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2">
                    <span className="sr-only">Gateway URL:</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
                      {url}
                    </code>
                    <CopyButton value={url} label={`Copy gateway URL for ${route}`} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Page({ params }: Props) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10">
      <Link
        href="/directory"
        className="w-fit text-sm text-accent underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        ← Back to the directory
      </Link>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <ListingContent params={params} />
      </Suspense>
    </main>
  );
}
