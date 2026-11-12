import Link from "next/link";
import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import { CallFeed } from "@/components/call-feed";
import { requirePrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { balanceOf } from "@/lib/ledger";
import { sellerListings } from "@/lib/listings";
import { formatUsd } from "@/lib/money";
import { listPayouts } from "@/lib/payouts";
import { EndpointRow } from "./endpoint-row";
import { WithdrawButton } from "./withdraw-button";

export const metadata = { title: "Seller console · Piko" };

const button = "rounded-md border border-line px-3 py-2 text-sm hover:bg-surface";

// Reads the session cookie, so it renders at request time inside a Suspense boundary.
async function SellerConsoleContent() {
  const { account, org, role } = await requirePrincipal("seller");
  const db = getDb();
  const [earnings, listings, payouts] = await Promise.all([
    balanceOf(db, { type: "seller", orgId: org.id }),
    sellerListings(db, { orgId: org.id, slug: org.slug }, getEnv().APP_BASE_URL),
    listPayouts(db, org.id),
  ]);
  const withdrawable = (earnings / 10_000n) * 10_000n;
  const canEdit = role === "admin";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Seller console</h1>
          <p className="text-muted">
            Signed in as {account.name} ({org.name}).
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canEdit && (
            <Link
              href="/seller/connect"
              className="rounded-md bg-brand px-3 py-2 text-sm text-brand-foreground hover:opacity-90"
            >
              Connect an API
            </Link>
          )}
          <form action={logout}>
            <button className={button}>Sign out</button>
          </form>
        </div>
      </header>

      <section className="flex flex-col gap-1 rounded-xl border border-line p-5">
        <h2 className="text-sm text-muted">Earnings balance</h2>
        <p className="text-3xl font-semibold tabular-nums">{formatUsd(earnings)}</p>
        <p className="text-sm text-muted">
          What buyers&rsquo; Calls have paid {org.name}, after the platform fee and less Payouts. It
          is paid out to PayPal automatically at {formatUsd(getEnv().PAYOUT_THRESHOLD_MICRO)}.
        </p>
        {canEdit && (
          <div className="pt-2">
            <WithdrawButton
              disabled={withdrawable <= 0n}
              label={`Withdraw ${formatUsd(withdrawable)} to PayPal`}
            />
          </div>
        )}
        {payouts.length > 0 && (
          <ul aria-label="Payouts" className="mt-3 flex flex-col gap-1 text-sm">
            {payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-2 tabular-nums">
                <span>{formatUsd(p.amountMicro)}</span>
                <span className="text-muted">
                  {p.status} · {p.createdAt.toLocaleString()}
                  {p.paypalBatchId && <> · batch {p.paypalBatchId}</>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CallFeed side="seller" />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-medium">Listings</h2>
        {!canEdit && (
          <p className="text-sm text-muted">Only an admin of {org.name} can change prices.</p>
        )}
        {listings.length === 0 ? (
          <p className="text-muted">
            No Listings yet.{" "}
            {canEdit && (
              <Link href="/seller/connect" className="underline">
                Connect an API
              </Link>
            )}
          </p>
        ) : (
          listings.map((listing) => (
            <article key={listing.id} className="flex flex-col gap-3 rounded-xl border border-line">
              <div className="flex flex-col gap-1 px-4 pt-4">
                <h3 className="text-lg font-medium">
                  {listing.name}{" "}
                  <span className="text-sm font-normal text-muted">
                    {listing.kind === "both" ? "HTTP + MCP" : listing.kind.toUpperCase()}
                  </span>
                </h3>
                <p className="text-sm text-muted">{listing.description}</p>
              </div>
              <ul className="flex flex-col divide-y divide-line border-t border-line">
                {listing.endpoints.map((e) => (
                  <EndpointRow
                    key={e.id}
                    id={e.id}
                    method={e.method}
                    path={e.path}
                    price={formatUsd(e.priceMicro)}
                    freeQuota={e.freeQuota}
                    gatewayUrl={e.gatewayUrl}
                    canEdit={canEdit}
                  />
                ))}
              </ul>
            </article>
          ))
        )}
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <SellerConsoleContent />
    </Suspense>
  );
}
