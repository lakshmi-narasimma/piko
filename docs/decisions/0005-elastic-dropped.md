# 0005. Elastic is not used

**Status:** Accepted · 2026-11-04

## Context
Elastic Cloud offers a 14-day trial, after which projects are suspended. A trial started in early November would expire before judging (Dec 1–15).

## Decision
Directory search uses Gemini embeddings stored in Postgres (pgvector on Neon, or in-app cosine similarity if the extension is unavailable).

## Consequences
One fewer sponsor tool. Revisit only if the sponsor provides credits that last through judging.
