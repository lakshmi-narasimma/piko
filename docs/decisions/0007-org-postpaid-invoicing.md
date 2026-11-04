# 0007. Orgs are billed afterwards through PayPal Invoicing; solo devs prepay

**Status:** Accepted · 2026-11-04

## Context
Companies rarely top up a wallet; they expect a monthly bill. A prepaid balance gives solo devs a natural hard limit.

## Decision
Solo devs top up through Orders v2. Orgs get a credit limit and a monthly PayPal invoice (Invoicing v2, a line item per team). Unpaid past the limit, the org's keys pause. If PayPal's limited-release Usage-based Billing becomes available, it may replace Piko's own invoice calculation.

## Consequences
A third PayPal product (with Orders and Payouts) used for a real reason. The demo needs a "generate invoice now" button.
