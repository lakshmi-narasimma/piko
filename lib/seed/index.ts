/**
 * The minimal demo world (BACKLOG P1-07, docs/SEED_DATA.md). P9-01 grows this into the full
 * world. Seeding resets the database first, so running it twice leaves the same state.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accounts,
  agents,
  endpoints,
  ledgerEntries,
  listings,
  memberships,
  orgs,
} from "../db/schema";
import { createKey } from "../keys";
import { seedAcmeTemp } from "./acme-temp";

export const PRIYA_SEED_BALANCE_MICRO = 940_000n;

/** Acme Corp's credit limit, $500 (docs/SEED_DATA.md §2). */
export const ACME_CREDIT_LIMIT_MICRO = 500_000_000n;

/** The Ledger's unique index keys on ref_id, so the seed uses a fixed one. */
const PRIYA_SEED_REF = "seed:priya-labs-balance";

const SELLER_ORGS = [
  { slug: "priya", name: "Priya Labs", email: "priya@demo.piko", person: "Priya" },
  { slug: "datacorp", name: "DataCorp", email: "omar@datacorp.demo", person: "Omar" },
] as const;

type SellerSlug = (typeof SELLER_ORGS)[number]["slug"];

const LISTINGS: ReadonlyArray<{
  seller: SellerSlug;
  slug: string;
  name: string;
  description: string;
  kind: "http" | "both";
  category: string;
  rating: string;
  method: "GET" | "POST";
  path: string;
  priceMicro: bigint;
  freeQuota: number;
}> = [
  {
    seller: "datacorp",
    slug: "product-search",
    name: "Product Search",
    description: "Search live products by keyword and get names, prices and links.",
    kind: "both",
    category: "search",
    rating: "4.7",
    method: "GET",
    path: "/search",
    priceMicro: 10_000n,
    freeQuota: 5,
  },
  {
    seller: "priya",
    slug: "review-summariser",
    name: "Review Summariser",
    description: "Summarise a product's customer reviews into pros, cons and a verdict.",
    kind: "both",
    category: "reviews",
    rating: "4.6",
    method: "POST",
    path: "/summarise",
    priceMicro: 5_000n,
    freeQuota: 0,
  },
  {
    seller: "priya",
    slug: "price-history",
    name: "Price History",
    description: "Price history for one product over the last 90 days.",
    kind: "both",
    category: "pricing",
    rating: "4.8",
    method: "GET",
    path: "/history",
    priceMicro: 2_000n,
    freeQuota: 0,
  },
  {
    seller: "datacorp",
    slug: "cheap-reviews",
    name: "Cheap Reviews",
    description: "Low-cost review summaries. Cheaper than Review Summariser and rated far lower.",
    kind: "http",
    category: "reviews",
    rating: "2.1",
    method: "POST",
    path: "/summarise",
    priceMicro: 3_000n,
    freeQuota: 0,
  },
];

export interface SeedOptions {
  /** Where the app runs. Listings point at the sample seller APIs under it. */
  appBaseUrl: string;
  /**
   * Starts Sam's wallet with this many micro-USD instead of $0.00. For running a paid Call
   * before PayPal top-ups (Phase 2) exist; the demo itself starts from a real top-up.
   */
  samWalletMicro?: bigint;
}

export interface SeedResult {
  /** Sam's raw agent Key, the only time it is available. */
  samKey: string;
}

/**
 * Empties every application table, then creates the minimal demo world, all in one
 * transaction. TRUNCATE is the only way to clear the Ledger: its trigger rejects DELETE.
 */
export function seed(db: Db, { appBaseUrl, samWalletMicro }: SeedOptions): Promise<SeedResult> {
  const sellersBaseUrl = `${appBaseUrl.replace(/\/+$/, "")}/api/demo/sellers`;

  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const tables = rows.map(({ tablename }) => sql.identifier(tablename));
    await tx.execute(sql`truncate table ${sql.join(tables, sql`, `)} restart identity cascade`);

    async function createOrg(values: typeof orgs.$inferInsert, person: string, email: string) {
      const [org] = await tx.insert(orgs).values(values).returning({ id: orgs.id });
      const [account] = await tx
        .insert(accounts)
        .values({ email, name: person })
        .returning({ id: accounts.id });
      await tx
        .insert(memberships)
        .values({ accountId: account!.id, orgId: org!.id, role: "admin" });
      return org!.id;
    }

    const samOrgId = await createOrg(
      { name: "Sam (personal)", slug: "sam", kind: "personal", billing: "prepaid" },
      "Sam",
      "sam@demo.piko",
    );
    const [samAgent] = await tx
      .insert(agents)
      .values({ orgId: samOrgId, name: "shopping-assistant" })
      .returning({ id: agents.id });
    const samKey = await createKey(tx, samAgent!.id);

    // Dana's org. Its teams, agents, budgets and policies come with the full world (P9-01).
    await createOrg(
      {
        name: "Acme Corp",
        slug: "acme",
        kind: "company",
        billing: "invoiced",
        creditLimitMicro: ACME_CREDIT_LIMIT_MICRO,
      },
      "Dana",
      "dana@acme.demo",
    );

    const sellerOrgIds = new Map<SellerSlug, string>();
    for (const { slug, name, email, person } of SELLER_ORGS) {
      const orgId = await createOrg(
        { name, slug, kind: "company", billing: "prepaid" },
        person,
        email,
      );
      sellerOrgIds.set(slug, orgId);
    }

    for (const { seller, method, path, priceMicro, freeQuota, ...listing } of LISTINGS) {
      const [row] = await tx
        .insert(listings)
        .values({
          ...listing,
          sellerOrgId: sellerOrgIds.get(seller)!,
          baseUrl: `${sellersBaseUrl}/${listing.slug}`,
        })
        .returning({ id: listings.id });
      await tx
        .insert(endpoints)
        .values({ listingId: row!.id, method, pathOrTool: path, priceMicro, freeQuota });
    }

    await tx.insert(ledgerEntries).values({
      txnId: sql`gen_random_uuid()`,
      accountType: "seller",
      orgId: sellerOrgIds.get("priya")!,
      amountMicro: PRIYA_SEED_BALANCE_MICRO,
      reason: "seed",
      refId: PRIYA_SEED_REF,
    });

    if (samWalletMicro && samWalletMicro > 0n) {
      await tx.insert(ledgerEntries).values({
        txnId: sql`gen_random_uuid()`,
        accountType: "wallet",
        orgId: samOrgId,
        amountMicro: samWalletMicro,
        reason: "seed",
        refId: "seed:sam-wallet",
      });
    }

    // Temporary until P9-01: Acme's teams, agents and budgets for the Org console.
    await seedAcmeTemp(tx);

    return { samKey: samKey.rawKey };
  });
}
