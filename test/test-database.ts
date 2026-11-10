import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Where tests find TEST_DATABASE_URL: the shell first, then .env.test.local, then
 * .env.local. Only the database variables are read from those files.
 */
function readLocalEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const file of [".env.local", ".env.test.local"]) {
    const full = path.join(process.cwd(), file);
    if (existsSync(full)) Object.assign(merged, parseEnv(readFileSync(full, "utf8")));
  }
  return merged;
}

export function resolveDatabaseUrls() {
  const local = readLocalEnv();
  const pick = (name: string) => process.env[name] || local[name] || undefined;
  return {
    test: pick("TEST_DATABASE_URL"),
    app: [pick("DATABASE_URL"), pick("DATABASE_URL_POOLED")].filter((url): url is string => !!url),
  };
}

// Neon's pooled host is the direct host plus "-pooler"; both reach the same database.
// A URL with no port means Postgres's default, so treat it as 5432. Host names are case-insensitive.
function databaseIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace("-pooler", "");
  return `${host}:${parsed.port || "5432"}${parsed.pathname}`;
}

/** Tests drop and recreate the schema, so they must never point at the app's database. */
export function assertSeparateTestDatabase(testUrl: string, appUrls: string[]): void {
  const target = databaseIdentity(testUrl);
  if (appUrls.some((url) => databaseIdentity(url) === target)) {
    throw new Error(
      "TEST_DATABASE_URL points at the same database as DATABASE_URL or DATABASE_URL_POOLED. " +
        "Tests reset their database, so use a separate one (see .env.example).",
    );
  }
}
