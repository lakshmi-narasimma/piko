import { describe, expect, it } from "vitest";
import { assertSeparateTestDatabase } from "./test-database";

describe("assertSeparateTestDatabase", () => {
  const direct = "postgresql://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require";
  const pooled =
    "postgresql://u:p@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  it("refuses the app database, through either its direct or pooled URL", () => {
    expect(() => assertSeparateTestDatabase(direct, [direct])).toThrow(/TEST_DATABASE_URL/);
    expect(() => assertSeparateTestDatabase(pooled, [direct])).toThrow(/TEST_DATABASE_URL/);
  });

  it("treats a missing port and an explicit :5432 as the same database", () => {
    const explicit = direct.replace(".neon.tech/", ".neon.tech:5432/");
    expect(() => assertSeparateTestDatabase(explicit, [direct])).toThrow(/TEST_DATABASE_URL/);
    expect(() => assertSeparateTestDatabase(direct, [explicit])).toThrow(/TEST_DATABASE_URL/);
  });

  it("compares host names without case", () => {
    const upper = direct.replace(
      "ep-cool-1.eu-central-1.aws.neon.tech",
      "EP-COOL-1.EU-CENTRAL-1.AWS.NEON.TECH",
    );
    expect(() => assertSeparateTestDatabase(upper, [direct])).toThrow(/TEST_DATABASE_URL/);
  });

  it("checks DATABASE_URL_POOLED too, with an explicit port on the pooled host", () => {
    const local = "postgresql://postgres:postgres@localhost:5432/piko_test";
    const pooledExplicit = pooled.replace(".neon.tech/", ".neon.tech:5432/");
    expect(() => assertSeparateTestDatabase(pooledExplicit, [local, pooled])).toThrow(
      /TEST_DATABASE_URL/,
    );
    expect(() => assertSeparateTestDatabase(direct, [local, pooledExplicit])).toThrow(
      /TEST_DATABASE_URL/,
    );
  });

  it("still tells apart a different port on the same host", () => {
    const other = direct.replace(".neon.tech/", ".neon.tech:6543/");
    expect(() => assertSeparateTestDatabase(other, [direct])).not.toThrow();
  });

  it("accepts a different database or host", () => {
    const local = "postgresql://postgres:postgres@localhost:5432/piko_test";
    const otherDb = direct.replace("/neondb", "/piko_test");
    expect(() => assertSeparateTestDatabase(local, [direct, pooled])).not.toThrow();
    expect(() => assertSeparateTestDatabase(otherDb, [direct, pooled])).not.toThrow();
  });
});
