import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  accounts,
  agents,
  apiKeys,
  endpoints,
  ledgerEntries,
  listings,
  memberships,
  orgs,
} from "../db/schema";
import { authenticateKey } from "../keys";
import { balanceOf } from "../ledger";
import { PRIYA_SEED_BALANCE_MICRO, seed } from "./index";

const url = inject("testDatabaseUrl");

// Seeding truncates every table and test files share one database, so this file gets its own.
describe.skipIf(!url)("seed", () => {
  const databaseName = `piko_seed_${randomUUID().replaceAll("-", "")}`;
  const appBaseUrl = "http://localhost:3000";
  let db: Db;

  async function admin(statement: string) {
    const client = new Client({ connectionString: url! });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  /** Every seeded row's business fields, without generated ids, timestamps or key material. */
  async function snapshot() {
    const orgRows = await db.select().from(orgs).orderBy(asc(orgs.slug));
    const orgSlug = new Map(orgRows.map((org) => [org.id, org.slug]));
    const listingRows = await db.select().from(listings).orderBy(asc(listings.slug));
    const listingSlug = new Map(listingRows.map((row) => [row.id, row.slug]));
    const endpointRows = await db.select().from(endpoints);
    return {
      orgs: orgRows.map(({ name, slug, kind, billing, creditLimitMicro }) => ({
        name,
        slug,
        kind,
        billing,
        creditLimitMicro,
      })),
      accounts: (await db.select().from(accounts).orderBy(asc(accounts.email))).map(
        ({ email, name }) => ({ email, name }),
      ),
      memberships: (await db.select().from(memberships))
        .map(({ orgId, role }) => ({ org: orgSlug.get(orgId), role }))
        .sort((a, b) => a.org!.localeCompare(b.org!)),
      agents: (await db.select().from(agents)).map(({ orgId, name, teamId }) => ({
        org: orgSlug.get(orgId),
        name,
        teamId,
      })),
      listings: listingRows.map(({ sellerOrgId, slug, name, baseUrl, kind, category, rating }) => ({
        seller: orgSlug.get(sellerOrgId),
        slug,
        name,
        baseUrl,
        kind,
        category,
        rating,
      })),
      endpoints: endpointRows
        .map(({ listingId, method, pathOrTool, priceMicro, freeQuota }) => ({
          listing: listingSlug.get(listingId),
          method,
          pathOrTool,
          priceMicro,
          freeQuota,
        }))
        .sort((a, b) => a.listing!.localeCompare(b.listing!)),
      ledger: (await db.select().from(ledgerEntries)).map(
        ({ accountType, orgId, amountMicro, reason, refId }) => ({
          accountType,
          org: orgId && orgSlug.get(orgId),
          amountMicro,
          reason,
          refId,
        }),
      ),
      keyCount: (await db.select().from(apiKeys)).length,
    };
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(url!);
    databaseUrl.pathname = `/${databaseName}`;
    await runMigrations(databaseUrl.toString());
    db = createDb(databaseUrl.toString(), { max: 2 });
  });

  afterAll(async () => {
    await db?.$client.end();
    await admin(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  it("creates the minimal demo world", async () => {
    const { samKey } = await seed(db, { appBaseUrl });
    const state = await snapshot();

    expect(state.orgs.map((org) => org.slug)).toEqual(["datacorp", "priya", "sam"]);
    expect(state.agents).toEqual([{ org: "sam", name: "shopping-assistant", teamId: null }]);
    expect(state.keyCount).toBe(1);
    expect(state.listings.map(({ slug, seller }) => [slug, seller])).toEqual([
      ["cheap-reviews", "datacorp"],
      ["price-history", "priya"],
      ["product-search", "datacorp"],
      ["review-summariser", "priya"],
    ]);
    expect(state.listings[1]!.baseUrl).toBe("http://localhost:3000/api/demo/sellers/price-history");
    expect(state.endpoints).toEqual([
      {
        listing: "cheap-reviews",
        method: "POST",
        pathOrTool: "/summarise",
        priceMicro: 3_000n,
        freeQuota: 0,
      },
      {
        listing: "price-history",
        method: "GET",
        pathOrTool: "/history",
        priceMicro: 2_000n,
        freeQuota: 0,
      },
      {
        listing: "product-search",
        method: "GET",
        pathOrTool: "/search",
        priceMicro: 10_000n,
        freeQuota: 5,
      },
      {
        listing: "review-summariser",
        method: "POST",
        pathOrTool: "/summarise",
        priceMicro: 5_000n,
        freeQuota: 0,
      },
    ]);

    expect((await authenticateKey(db, samKey)).ok).toBe(true);

    const [priya] = await db.select().from(orgs).where(eq(orgs.slug, "priya"));
    expect(await balanceOf(db, { type: "seller", orgId: priya!.id })).toBe(
      PRIYA_SEED_BALANCE_MICRO,
    );
    expect(PRIYA_SEED_BALANCE_MICRO).toBe(940_000n);

    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: sam!.id })).toBe(0n);
  });

  it("leaves the same state when run twice, and invalidates the earlier key", async () => {
    const first = await seed(db, { appBaseUrl });
    const before = await snapshot();
    const second = await seed(db, { appBaseUrl });
    const after = await snapshot();

    expect(after).toEqual(before);
    expect((await authenticateKey(db, first.samKey)).ok).toBe(false);
    expect((await authenticateKey(db, second.samKey)).ok).toBe(true);
  });

  it("can start Sam's wallet funded, for running paid Calls before top-ups exist", async () => {
    await seed(db, { appBaseUrl, samWalletMicro: 5_000_000n });
    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: sam!.id })).toBe(5_000_000n);
  });

  it("clears rows the Ledger's trigger would refuse to delete", async () => {
    await seed(db, { appBaseUrl });
    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId: sam!.id,
      amountMicro: 5_000_000n,
      reason: "seed",
      refId: randomUUID(),
    });

    await seed(db, { appBaseUrl });

    const [samAfter] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: samAfter!.id })).toBe(0n);
  });
});
