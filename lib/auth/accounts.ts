import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, memberships, orgs } from "../db/schema";
import { verifyPassword } from "./password";

/** The three signed-in areas. Which one a person gets follows from their org. */
export type Area = "wallet" | "org" | "seller";

export const AREA_PATH: Record<Area, string> = {
  wallet: "/wallet",
  org: "/org",
  seller: "/seller",
};

export interface Principal {
  account: { id: string; email: string; name: string };
  org: { id: string; name: string; slug: string; kind: "personal" | "company" };
  role: "admin" | "member";
  area: Area;
}

/** Solo devs get the Wallet, invoiced companies the Org console, prepaid companies the Seller console. */
export function areaFor(org: { kind: "personal" | "company"; billing: "prepaid" | "invoiced" }) {
  if (org.kind === "personal") return "wallet";
  return org.billing === "invoiced" ? "org" : "seller";
}

/** The persona switcher's cards (docs/SEED_DATA.md §1). */
export const PERSONAS = [
  { email: "sam@demo.piko", name: "Sam", blurb: "Solo dev with a prepaid Wallet" },
  { email: "dana@acme.demo", name: "Dana", blurb: "Admin of Acme Corp, billed by invoice" },
  { email: "priya@demo.piko", name: "Priya", blurb: "Sells APIs through Priya Labs" },
  { email: "omar@datacorp.demo", name: "Omar", blurb: "Sells APIs through DataCorp" },
] as const;

/** Emails are compared without case, so `Sam@demo.piko` is the same account as `sam@demo.piko`. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailIs(email: string) {
  return eq(sql`lower(${accounts.email})`, normalizeEmail(email));
}

/** True only for the seeded demo personas, the one set of accounts that may log in without a password. */
export function isPersona(email: string): boolean {
  const wanted = normalizeEmail(email);
  return PERSONAS.some((persona) => persona.email === wanted);
}

/** An account's first org, or null if it has none. */
async function principalFor(db: Db, where: ReturnType<typeof eq>): Promise<Principal | null> {
  const [row] = await db
    .select({ account: accounts, org: orgs, role: memberships.role })
    .from(accounts)
    .innerJoin(memberships, eq(memberships.accountId, accounts.id))
    .innerJoin(orgs, eq(orgs.id, memberships.orgId))
    .where(where)
    .orderBy(asc(orgs.createdAt))
    .limit(1);
  return row ? toPrincipal(row) : null;
}

function toPrincipal(row: {
  account: typeof accounts.$inferSelect;
  org: typeof orgs.$inferSelect;
  role: "admin" | "member";
}): Principal {
  return {
    account: { id: row.account.id, email: row.account.email, name: row.account.name },
    org: { id: row.org.id, name: row.org.name, slug: row.org.slug, kind: row.org.kind },
    role: row.role,
    area: areaFor(row.org),
  };
}

/**
 * Passwordless lookup for the persona switcher. The caller must have checked DEMO_MODE.
 * A server action's arguments come from the client, so this refuses any email that isn't
 * one of the PERSONAS: otherwise demo mode would be a passwordless login for every account.
 */
export async function findPersona(db: Db, email: string): Promise<Principal | null> {
  if (!isPersona(email)) return null;
  return principalFor(db, emailIs(email));
}

/** Email and password login. Null for an unknown email, a wrong password or no password set. */
export async function findByPassword(
  db: Db,
  email: string,
  password: string,
): Promise<Principal | null> {
  const [row] = await db
    .select({ hash: accounts.passwordHash })
    .from(accounts)
    .where(emailIs(email))
    .limit(1);
  // Verify even when no hash exists so the response time doesn't reveal which emails exist.
  const ok = await verifyPassword(password, row?.hash ?? "scrypt:AA:AA");
  return ok ? principalFor(db, emailIs(email)) : null;
}

/** Reloads a session's principal. Null if the account left the org or no longer exists. */
export async function loadPrincipal(
  db: Db,
  accountId: string,
  orgId: string,
): Promise<Principal | null> {
  return principalFor(db, and(eq(accounts.id, accountId), eq(orgs.id, orgId))!);
}
