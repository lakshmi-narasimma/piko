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

  it("accepts a different database or host", () => {
    const local = "postgresql://postgres:postgres@localhost:5432/piko_test";
    const otherDb = direct.replace("/neondb", "/piko_test");
    expect(() => assertSeparateTestDatabase(local, [direct, pooled])).not.toThrow();
    expect(() => assertSeparateTestDatabase(otherDb, [direct, pooled])).not.toThrow();
  });
});
