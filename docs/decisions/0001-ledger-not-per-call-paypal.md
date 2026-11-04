# 0001. Per-call money lives on Piko's ledger, not in PayPal

**Status:** Accepted · 2026-11-04

## Context
PayPal's micropayments rate is about 4.99% + $0.09 per transaction. A $0.002 API call would cost 45× its price in fees, so calling PayPal once per API call is impossible.

## Decision
Buyers fund a balance (prepaid top-up through Orders v2) or are billed afterwards (Invoicing v2). Each Call writes three ledger entries (buyer −, seller +95%, platform +5%) with no PayPal call. Sellers are paid in batches through Payouts once they reach $1.00.

## Consequences
Calls settle in milliseconds and cost nothing in fees. Piko holds balances, which in production counts as stored value or money transmission. The pitch says so openly: production would run on PayPal's multiparty setup, with PayPal holding the funds.
