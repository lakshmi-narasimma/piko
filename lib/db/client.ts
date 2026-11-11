import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * pg 8 already treats sslmode=require (Neon's default) as verify-full and warns that this
 * will change in pg 9. Say verify-full explicitly: same behaviour today, no weakening later.
 */
export function withVerifiedSsl(connectionString: string): string {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  if (mode === "prefer" || mode === "require" || mode === "verify-ca") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

/** A Drizzle client over its own pg Pool. Callers that create one must `$client.end()` it. */
export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new Pool({
    connectionString: withVerifiedSsl(connectionString),
    max: options.max ?? 5,
  });
  return drizzle(pool, { schema });
}

// One pool per server process, kept on globalThis so dev hot reloads don't leak pools.
const globalForDb = globalThis as typeof globalThis & { __pikoDb?: Db };

/**
 * The app's database client. It uses DATABASE_URL_POOLED (Neon's pooler); migrations
 * use the direct DATABASE_URL instead (see lib/db/migrate.ts).
 */
export function getDb(): Db {
  globalForDb.__pikoDb ??= createDb(getEnv().DATABASE_URL_POOLED);
  return globalForDb.__pikoDb;
}
