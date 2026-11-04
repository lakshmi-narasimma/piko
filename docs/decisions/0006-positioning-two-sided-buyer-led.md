# 0006. Two-sided network, pitched buyer-first

**Status:** Accepted · 2026-11-04

## Context
Demand for agents discovering and paying unknown sellers is unproven (CoinDesk, Mar 2026). The buyer pains (one wallet instead of many signups; companies controlling agent spend) are provable today. Paid MCP tools on Stripe or crypto already exist (Stripe MPP, Cloudflare paidTool, Apify, xpay, FiatDock, Tollwicket). None of them is on PayPal, and none offers org controls for buyers.

## Decision
Piko is one network with two sides: the Wallet (solo devs and orgs) and the Gateway (solo devs and orgs as sellers). The pitch leads with buyer controls enforced at payment time and the PayPal rail. The seller side is shown as the supply and the bonus. Pitch line: "Piko makes PayPal the default way AI agents pay, and get paid."

## Consequences
Paid MCP tools are a demo moment, not the innovation claim. Org controls carry the innovation story.
