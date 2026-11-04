# 0009. All money is integer micro-USD

**Status:** Accepted · 2026-11-04

## Context
Per-call prices are fractions of a cent ($0.002), and floating point drifts under repeated sums.

## Decision
Amounts are stored and computed as `bigint` micro-USD (1 USD = 1,000,000), serialised as strings in JSON, and converted only for display. The 5% fee is rounded down for the seller, and the remainder goes to the platform.

## Consequences
Exact sums, and a ledger whose entries always balance. Every API client must handle string amounts.
