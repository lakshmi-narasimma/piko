import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import { requirePrincipal } from "@/lib/auth";

export const metadata = { title: "Wallet · Piko" };

// Reads the session cookie, so it renders at request time inside a Suspense boundary.
async function WalletContent() {
  const { account, org } = await requirePrincipal("wallet");
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center gap-4 px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Wallet</h1>
      <p className="text-muted">
        Signed in as {account.name} ({org.name}). The balance, top-up and keys arrive in P2-06.
      </p>
      <form action={logout}>
        <button className="rounded-md border border-line px-3 py-2 hover:bg-surface">
          Sign out
        </button>
      </form>
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
