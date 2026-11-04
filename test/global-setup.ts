import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { withVerifiedSsl } from "../lib/db/client";
import { runMigrations } from "../lib/db/migrate";
import { assertSeparateTestDatabase, resolveDatabaseUrls } from "./test-database";

declare module "vitest" {
  export interface ProvidedContext {
    /** Freshly reset and migrated test database, or null when none is configured. */
    testDatabaseUrl: string | null;
  }
}

/**
 * Before the test run: wipe the test database and apply every migration, so each run
 * starts from an empty, fully migrated schema. Without TEST_DATABASE_URL the database
 * tests are skipped locally, and the run fails in CI.
 */
export default async function setup(project: TestProject) {
  const { test: url, app } = resolveDatabaseUrls();

  if (!url) {
    if (process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI.");
    console.warn("TEST_DATABASE_URL is not set: database tests are skipped.");
    project.provide("testDatabaseUrl", null);
    return;
  }

  assertSeparateTestDatabase(url, app);

  const client = new Client({ connectionString: withVerifiedSsl(url) });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }

  await runMigrations(url);
  project.provide("testDatabaseUrl", url);
}
