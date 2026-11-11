import { randomUUID } from "node:crypto";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";
import { agents, endpoints, ledgerEntries, listings, orgs, teams, webhookEvents } from "./schema";

const url = inject("testDatabaseUrl");

// Every table in DESIGN.md section 12, plus webhook_events.
const DESIGN_TABLES = [
  "accounts",
  "agents",
  "alerts",
  "api_keys",
  "approvals",
  "budgets",
  "calls",
  "challenges",
  "endpoints",
  "invoices",
  "ledger_entries",
  "listings",
  "memberships",
  "orgs",
  "payouts",
  "policies",
  "rate_overrides",
  "teams",
  "topups",
  "webhook_events",
];

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe("schema", () => {
  it("defines every table in the design", () => {
    expect(tables.map(getTableName).sort()).toEqual(DESIGN_TABLES);
  });

  it("stores every amount as a bigint", () => {
    const amounts = tables.flatMap((table) =>
      getTableConfig(table).columns.filter((column) => column.name.endsWith("_micro")),
    );
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.filter((column) => column.getSQLType() !== "bigint")).toEqual([]);
  });
});

describe.skipIf(!url)("schema in the database", () => {
  let db: Db;
  let orgId: string;

  const entry = (overrides: Partial<typeof ledgerEntries.$inferInsert> = {}) => ({
    txnId: randomUUID(),
    accountType: "wallet" as const,
    orgId,
    amountMicro: -2000n,
    reason: "call" as const,
    refId: randomUUID(),
    ...overrides,
  });

  // drizzle wraps driver errors, so look through `cause` for the Postgres message.
  const failure = async (write: Promise<unknown>) => {
    const error = await write.then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    return error?.cause?.message ?? error?.message ?? "no error";
  };

  beforeAll(async () => {
    db = createDb(url!);
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Schema Test",
        slug: `schema-test-${randomUUID()}`,
        kind: "personal",
        billing: "prepaid",
      })
      .returning({ id: orgs.id });
    orgId = org!.id;
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("creates every table", async () => {
    const { rows } = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(expect.arrayContaining(DESIGN_TABLES));
  });

  it("returns ledger amounts as exact bigints", async () => {
    const amount = -9_007_199_254_740_993n;
    const [row] = await db
      .insert(ledgerEntries)
      .values(entry({ amountMicro: amount }))
      .returning();
    expect(row?.amountMicro).toBe(amount);
  });

  it("rejects updates to ledger entries", async () => {
    const [row] = await db.insert(ledgerEntries).values(entry()).returning();
    const update = db
      .update(ledgerEntries)
      .set({ amountMicro: 1n })
      .where(eq(ledgerEntries.id, row!.id));
    expect(await failure(update)).toContain("append-only");
  });

  it("rejects deletes of ledger entries", async () => {
    const [row] = await db.insert(ledgerEntries).values(entry()).returning();
    const remove = db.delete(ledgerEntries).where(eq(ledgerEntries.id, row!.id));
    expect(await failure(remove)).toContain("append-only");
  });

  it("rejects posting the same event twice to one account", async () => {
    const first = entry();
    await db.insert(ledgerEntries).values(first);
    const duplicate = db.insert(ledgerEntries).values({ ...first, txnId: randomUUID() });
    expect(await failure(duplicate)).toContain("ledger_entries_once_per_event");
  });

  it("allows one Call to post to each of its three accounts", async () => {
    const refId = randomUUID();
    const txnId = randomUUID();
    const rows = await db
      .insert(ledgerEntries)
      .values([
        entry({ txnId, refId, amountMicro: -2000n }),
        entry({ txnId, refId, accountType: "seller", amountMicro: 1900n }),
        entry({ txnId, refId, accountType: "platform", orgId: null, amountMicro: 100n }),
      ])
      .returning();
    expect(rows.reduce((sum, row) => sum + row.amountMicro, 0n)).toBe(0n);
  });

  it("requires an org on every account except the platform", async () => {
    expect(await failure(db.insert(ledgerEntries).values(entry({ orgId: null })))).toContain(
      "ledger_entries_platform_has_no_org",
    );
    expect(
      await failure(db.insert(ledgerEntries).values(entry({ accountType: "platform" }))),
    ).toContain("ledger_entries_platform_has_no_org");
  });

  it("stores a replayed webhook only once, by event id and by resource", async () => {
    const event = {
      paypalEventId: randomUUID(),
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceId: randomUUID(),
      payload: {},
    };
    await db.insert(webhookEvents).values(event);

    expect(await failure(db.insert(webhookEvents).values(event))).toContain("unique");
    expect(
      await failure(db.insert(webhookEvents).values({ ...event, paypalEventId: randomUUID() })),
    ).toContain("webhook_events_once_per_resource");
  });

  const newOrg = async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Org", slug: `org-${randomUUID()}`, kind: "company", billing: "prepaid" })
      .returning({ id: orgs.id });
    return org!.id;
  };

  const newListing = async (sellerOrgId: string) => {
    const [listing] = await db
      .insert(listings)
      .values({
        sellerOrgId,
        slug: `listing-${randomUUID()}`,
        name: "Listing",
        description: "For schema tests",
        baseUrl: "http://localhost:9",
        kind: "http",
      })
      .returning({ id: listings.id });
    return listing!.id;
  };

  const newEndpoint = (listingId: string, path: string) =>
    db
      .insert(endpoints)
      .values({ listingId, method: "GET", pathOrTool: path, priceMicro: 1000n })
      .returning();

  it("keeps an agent's team inside the agent's org, and allows no team", async () => {
    const otherOrgId = await newOrg();
    const [team] = await db
      .insert(teams)
      .values({ orgId: otherOrgId, name: `team-${randomUUID()}` })
      .returning({ id: teams.id });

    const crossOrg = db.insert(agents).values({ orgId, teamId: team!.id, name: randomUUID() });
    expect(await failure(crossOrg)).toContain("agents_team_same_org_fk");

    const sameOrg = await db
      .insert(agents)
      .values({ orgId: otherOrgId, teamId: team!.id, name: randomUUID() })
      .returning();
    expect(sameOrg[0]?.teamId).toBe(team!.id);
    const noTeam = await db.insert(agents).values({ orgId, name: randomUUID() }).returning();
    expect(noTeam[0]?.teamId).toBeNull();
  });

  it("fills an endpoint's seller from its listing", async () => {
    const sellerId = await newOrg();
    const [endpoint] = await newEndpoint(await newListing(sellerId), "/fill");
    expect(endpoint?.sellerOrgId).toBe(sellerId);
  });

  it("rejects an endpoint whose seller is not its listing's seller", async () => {
    const listingId = await newListing(await newOrg());
    const mismatch = db.insert(endpoints).values({
      listingId,
      sellerOrgId: await newOrg(),
      method: "GET",
      pathOrTool: "/mismatch",
      priceMicro: 1000n,
    });
    expect(await failure(mismatch)).toContain("endpoints_listing_seller_fk");
  });

  it("makes a route unique per seller, across that seller's listings", async () => {
    const sellerId = await newOrg();
    await newEndpoint(await newListing(sellerId), "/summarise");

    const secondListing = newEndpoint(await newListing(sellerId), "/summarise");
    expect(await failure(secondListing)).toContain("endpoints_seller_route_unique");

    const otherSeller = await newEndpoint(await newListing(await newOrg()), "/summarise");
    expect(otherSeller).toHaveLength(1);
  });

  it("keeps a listing's rating between 0 and 5", async () => {
    const sellerId = await newOrg();
    const listing = (rating: string) =>
      db.insert(listings).values({
        sellerOrgId: sellerId,
        slug: `listing-${randomUUID()}`,
        name: "Rated",
        description: "For schema tests",
        baseUrl: "http://localhost:9",
        kind: "http",
        rating,
      });
    for (const bad of ["-0.1", "5.1"]) {
      expect(await failure(listing(bad))).toContain("listings_rating_range");
    }
    for (const good of ["0.0", "5.0"]) {
      await expect(listing(good)).resolves.toBeDefined();
    }
  });
});
