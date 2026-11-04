import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

export const migrationsFolder = path.join(process.cwd(), "lib/db/migrations");

/** Applies every pending migration in lib/db/migrations. Safe to run repeatedly. */
export async function runMigrations(connectionString: string): Promise<void> {
  const db = createDb(connectionString, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
}
