import { cookies } from "next/headers";
import Link from "next/link";
import { logout } from "@/app/login/actions";
import { ALERTS_SEEN_COOKIE, countUnread, unreadSince } from "@/lib/alerts";
import { AREA_PATH, getPrincipal, type Principal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AlertsBadge } from "./alerts-badge";

/** A broken database must not take every page down with it, so a failed lookup reads as signed out. */
async function currentPrincipal(): Promise<Principal | null> {
  try {
    return await getPrincipal();
  } catch {
    return null;
  }
}

/** The badge's first number, for an Org console admin; null for everyone else. */
async function unreadAlerts(principal: Principal | null): Promise<number | null> {
  if (principal?.area !== "org" || principal.role !== "admin") return null;
  try {
    const since = unreadSince((await cookies()).get(ALERTS_SEEN_COOKIE)?.value);
    return await countUnread(getDb(), { orgId: principal.org.id, since });
  } catch {
    return 0;
  }
}

const button =
  "rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent";

export async function SiteHeader() {
  const principal = await currentPrincipal();
  const unread = await unreadAlerts(principal);
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
              <Link
                href={AREA_PATH[principal.area]}
                className={`${button} inline-flex items-center`}
              >
                {principal.org.name}
                {unread !== null && <AlertsBadge initial={unread} />}
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
