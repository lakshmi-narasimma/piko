# 0003. Runtime AI runs on the Gemini API free tier

**Status:** Accepted · 2026-11-04

## Context
The team's Claude Pro plan covers building with Claude Code but not API calls made by the deployed app, and the team won't spend more money.

## Decision
The app's AI features (buyer agent, policy compiler, pricing assistant, embeddings) use Gemini's free tier through the Vercel AI SDK, behind a `lib/llm` module.

## Consequences
Rate limits are a judging-day risk: cache playground runs, show an "AI busy" fallback, and keep Groq as a drop-in alternative through `lib/llm`.
