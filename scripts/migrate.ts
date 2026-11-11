// `npm run db:migrate`: applies lib/db/migrations to DATABASE_URL, the direct (non-pooled)
// connection. Reads .env.local the same way Next.js does; a shell variable wins.
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import { runMigrations } from "../lib/db/migrate";

loadEnvConfig(process.cwd());

const url = z.url().safeParse(process.env.DATABASE_URL);
if (!url.success) {
  console.error("db:migrate: DATABASE_URL is missing or not a URL (see .env.example).");
  process.exit(1);
}

const databaseUrl = url.data;
console.log(`db:migrate: applying migrations to ${new URL(databaseUrl).host} ...`);
runMigrations(databaseUrl).then(
  () => console.log("db:migrate: done."),
  (error: unknown) => {
    console.error("db:migrate: failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
