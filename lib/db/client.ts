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

/**
 * A Drizzle client over its own pg Pool. Callers that create one must `$client.end()` it.
 *
 * An idle client can lose its connection at any time (Neon scales to zero and drops idle
 * connections). pg reports that as an 'error' event on the pool, and an EventEmitter with
 * no 'error' listener throws, which would crash the server. So the error is logged (its
 * message only, never the connection string) and pg discards that client. Idle clients
 * are also closed after 10 seconds, before the server side is likely to drop them.
 */
export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new Pool({
    connectionString: withVerifiedSsl(connectionString),
    max: options.max ?? 5,
    idleTimeoutMillis: 10_000,
  });
  pool.on("error", (error) => console.error("pg pool error", error.message));
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
