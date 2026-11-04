# 0008. Enforcement is deterministic code; AI only compiles policies

**Status:** Accepted · 2026-11-04

## Context
An LLM deciding whether money moves is unpredictable and impossible to audit. Org admins still want to write rules in plain English.

## Decision
Gemini turns plain English into a structured policy (schema-validated JSON). The admin sees the result and confirms it. Budgets, policies, the circuit breaker and the kill switch are enforced by plain code in `lib/policy` and `lib/breaker`.

## Consequences
Predictable, testable and auditable behaviour. AI mistakes are caught at confirmation, not at payment time.
