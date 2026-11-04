# 0002. x402-style protocol with a custom `paypal-ledger` scheme; Piko is the facilitator

**Status:** Accepted · 2026-11-04

## Context
x402 (HTTP 402 → pay → retry with proof) is becoming the standard for agent payments (Linux Foundation stewardship from July 2026; AWS Bedrock AgentCore support reported). It settles in USDC. Payment requirements carry a `scheme` and `network`, and facilitators advertise what they support.

## Decision
Piko follows x402's message shape and header names, defines scheme `paypal-ledger` on network `paypal:sandbox`, and exposes `/api/facilitator/{supported,verify,settle}`. An `X-Piko-Autopay` shortcut lets an agent with a key pay and call in one request.

## Consequences
The positioning becomes "the fiat payment method x402 is missing" rather than another billing API. Still open: the spec's rules for registering a new scheme (DESIGN.md §19).
