import Link from "next/link";
import { logout } from "@/app/login/actions";
import { AREA_PATH, getPrincipal, type Principal } from "@/lib/auth";

/** A broken database must not take every page down with it, so a failed lookup reads as signed out. */
async function currentPrincipal(): Promise<Principal | null> {
  try {
    return await getPrincipal();
  } catch {
    return null;
  }
}

const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent";

export async function SiteHeader() {
  const principal = await currentPrincipal();
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight text-brand">
          Piko
        </Link>
        <nav aria-label="Main" className="flex items-center gap-2 text-sm">
          {principal ? (
            <>
              {principal.area === "wallet" && (
                <Link href="/playground" className={button}>
                  Playground
                </Link>
              )}
              <Link href={AREA_PATH[principal.area]} className={button}>
                {principal.org.name}
              </Link>
              <form action={logout}>
                <button className={button}>Sign out</button>
              </form>
            </>
          ) : (
            <Link href="/login" className={button}>
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
