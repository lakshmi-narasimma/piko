# 0004. One Next.js app on Render's free tier, Postgres on Neon

**Status:** Accepted · 2026-11-04

## Context
Two people, Claude doing the building, a short deadline, no budget. Judges need a hosted URL. Render's free Postgres expires after about 30 days, which would fall inside the Dec 1–15 judging window.

## Decision
A single Next.js (App Router, TypeScript) app holds the UI, public API, gateway proxy, MCP server and webhooks. The database is Neon's free Postgres. A GitHub Action pings the app every 10 minutes so the free instance stays awake.

## Consequences
One deploy and one codebase. Cold starts of 30–60 s are still possible if the ping fails, so the README warns judges.
