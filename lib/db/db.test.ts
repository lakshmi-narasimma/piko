import { sql } from "drizzle-orm";
import { bigint, pgTable, serial, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "./client";

const url = inject("testDatabaseUrl");

// Test-only table, created as TEMP inside the transaction so it never outlives the test.
const healthcheck = pgTable("healthcheck", {
  id: serial("id").primaryKey(),
  note: text("note").notNull(),
  amountMicro: bigint("amount_micro", { mode: "bigint" }).notNull(),
});

describe.skipIf(!url)("database", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("starts from a migrated database with pgvector", async () => {
    const { rows } = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(rows).toEqual([{ extname: "vector" }]);
  });

  it("writes and reads a row, keeping bigint micro-USD exact", async () => {
    // Above Number.MAX_SAFE_INTEGER, so a float anywhere on the path would corrupt it.
    const amount = 9_007_199_254_740_993n;

    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`
        create temp table healthcheck (
          id serial primary key,
          note text not null,
          amount_micro bigint not null
        ) on commit drop
      `);
      await tx.insert(healthcheck).values({ note: "hello", amountMicro: amount });
      const [found] = await tx
        .select()
        .from(healthcheck)
        .where(sql`${healthcheck.note} = 'hello'`)
        .for("update");
      return found;
    });

    expect(row).toEqual({ id: 1, note: "hello", amountMicro: amount });
    expect(typeof row?.amountMicro).toBe("bigint");
  });
});
