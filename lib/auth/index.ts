import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { getEnv } from "../env";
import { AREA_PATH, loadPrincipal, type Area, type Principal } from "./accounts";
import { readSession, SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "./session";

export { AREA_PATH, PERSONAS, type Area, type Principal } from "./accounts";

/** Starts a session by setting the signed cookie. Call from a server action or route handler. */
export async function startSession(principal: Principal): Promise<void> {
  const env = getEnv();
  const token = signSession(
    { accountId: principal.account.id, orgId: principal.org.id },
    env.SESSION_SECRET,
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in person, or null. */
export async function getPrincipal(): Promise<Principal | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const claims = readSession(token, getEnv().SESSION_SECRET);
  return claims ? loadPrincipal(getDb(), claims.accountId, claims.orgId) : null;
}

/**
 * Guards a page. Signed-out visitors go to /login; someone in the wrong area goes to their own.
 * Pass no area for a page any signed-in person may see.
 */
export async function requirePrincipal(area?: Area): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) redirect("/login");
  if (area && principal.area !== area) redirect(AREA_PATH[principal.area]);
  return principal;
}
