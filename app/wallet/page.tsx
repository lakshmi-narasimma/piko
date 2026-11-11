import { Suspense } from "react";
import { logout } from "@/app/login/actions";
import { requirePrincipal } from "@/lib/auth";

export const metadata = { title: "Wallet · Piko" };

// Reads the session cookie, so it renders at request time inside a Suspense boundary.
async function WalletContent() {
  const { account, org } = await requirePrincipal("wallet");
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Wallet</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Signed in as {account.name} ({org.name}). The balance, top-up and keys arrive in P2-06.
      </p>
      <form action={logout}>
        <button className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700">
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
