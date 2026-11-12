import Link from "next/link";
import { Suspense } from "react";
import { requirePrincipal } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { ConnectForm } from "./connect-form";

export const metadata = { title: "Connect an API · Piko" };

// Reads the session cookie, so it renders at request time inside a Suspense boundary.
async function ConnectContent() {
  const { org, role } = await requirePrincipal("seller");
  const demoBaseUrl = `${getEnv().APP_BASE_URL.replace(/\/+$/, "")}/api/demo/sellers/price-history`;
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <Link href="/seller" className="text-sm text-muted hover:underline">
          ← Seller console
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Connect an API</h1>
        <p className="text-muted">
          Paste your API&rsquo;s base URL, price each endpoint, and publish. Each endpoint gets a
          gateway URL at once, and {org.name} is paid per Call.
        </p>
      </header>
      {role === "admin" ? (
        <ConnectForm demoBaseUrl={demoBaseUrl} />
      ) : (
        <p role="alert" className="text-muted">
          Only an admin of {org.name} can connect an API.
        </p>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ConnectContent />
    </Suspense>
  );
}
