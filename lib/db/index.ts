/**
 * Database access through Drizzle ORM over node-postgres (see docs/decisions/0012-drizzle.md).
 *
 * - `getDb()` is the app's client, on DATABASE_URL_POOLED.
 * - `runMigrations(url)` applies lib/db/migrations; `npm run db:migrate` runs it on DATABASE_URL.
 */
export { createDb, getDb, type Db } from "./client";
export { runMigrations } from "./migrate";
