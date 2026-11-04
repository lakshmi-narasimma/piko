# 0012. Drizzle ORM over node-postgres

**Status:** Accepted · 2026-11-05

## Context
DESIGN.md §11 left the ORM open between Drizzle and Prisma. What the choice has to carry:
- Every amount is a `bigint` of micro-USD ([0009](0009-integer-micro-usd.md)), and it must reach TypeScript as a `bigint`, never a `number`.
- The ledger is append-only. Each Call writes three entries in one transaction, and reserving funds must not overdraw under concurrency, so we need `SELECT … FOR UPDATE` or serializable transactions without dropping to raw SQL for every query.
- Directory search stores embeddings in a pgvector column.
- One Next.js app on Render's free tier, Postgres on Neon's free tier ([0004](0004-nextjs-monolith-render-neon.md)), with a pooled URL for the app and a direct one for migrations.
- Queries should read like the SQL they run, so they are easy to review.

## Decision
Use **Drizzle ORM** with the **node-postgres (`pg`)** driver and **drizzle-kit** for migrations.
- Tables live in `lib/db/schema.ts`. `npm run db:generate` writes SQL migrations to `lib/db/migrations`, and `npm run db:migrate` applies them to `DATABASE_URL` (direct). Hand-written SQL migrations (such as `CREATE EXTENSION vector`) use `drizzle-kit generate --custom`.
- The app connects through `getDb()` in `lib/db` on `DATABASE_URL_POOLED`. Render runs a long-lived Node server, so a plain `pg` Pool is enough, and `pg` uses unnamed statements, which suit Neon's PgBouncer pooler.
- Amount columns are `bigint(..., { mode: "bigint" })`.
- Tests use a separate database, `TEST_DATABASE_URL`, which the Vitest global setup wipes and re-migrates on each run. It refuses to run if that URL points at the app's database.

Why not Prisma: its `BigInt` and transactions work, but row locks (`FOR UPDATE`) and pgvector columns need raw SQL (`$queryRaw`, `Unsupported("vector")`). It also adds a generate step and a heavier client to the build. Drizzle supports `.for("update")`, `vector(...)` columns and nested transactions directly, and its migrations are plain SQL files we can read in review.

## Consequences
- Migrations are SQL files in git. Review them like code, and never edit one that has already been applied.
- Drizzle is pre-1.0 (0.45 at the time of writing), so pin versions and expect occasional API changes.
- No ORM-level guard stops `UPDATE` or `DELETE` on `ledger_entries`. The append-only rule rests on `lib/ledger` being the only writer. P1-01 can add a database guard too, such as a trigger that rejects updates and deletes.
- If we ever deploy to a serverless runtime, swap the driver for `@neondatabase/serverless`. Queries don't change.
