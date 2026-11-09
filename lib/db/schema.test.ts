import { randomUUID } from "node:crypto";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "./client";
import * as schema from "./schema";
import { ledgerEntries, orgs, webhookEvents } from "./schema";

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
});
