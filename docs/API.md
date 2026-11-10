# Piko API

How agents, sellers and the dashboard talk to Piko. The machine-readable contract for the **public API** (agent- and seller-facing) is [openapi.yaml](../openapi.yaml). APIMatic generates the buyer SDK from it and the Postman collection is imported from it, so it must stay at **10 operations or fewer** (APIMatic free plan). Dashboard routes are internal and documented only here.

Amounts are always **integer micro-USD as strings** (`"2000"` = $0.002), so JavaScript clients never lose precision.

---

## 1. Authentication

| Caller | How |
|---|---|
| Agent | `Authorization: Bearer pk_agent_<secret>`: an agent **Key** created in the Wallet or Org console. Piko stores only a hash plus the visible prefix. |
| Seller upstream | No auth from Piko by default. Optionally, a seller sets a shared secret that Piko sends as `X-Piko-Secret` so their API can reject direct traffic. |
| Dashboard | Session cookie (persona switcher in demo mode, email + password otherwise). |
| PayPal webhooks | PayPal signature, checked with `PAYPAL_WEBHOOK_ID` through PayPal's verify-webhook-signature API. |

## 2. The paid-call flow (x402 style)

```
1. Agent → GET /g/{seller}/{path}            (no payment header)
   ← 402  PAYMENT-REQUIRED: <base64 challenge>  + same challenge as JSON body

2. Agent → POST /api/pay  { nonce }          (Authorization: agent key)
   ← 200 { receipt }                          or an error from §4

3. Agent → GET /g/{seller}/{path}  PAYMENT-SIGNATURE: <receipt>
   Piko verifies + consumes the receipt, forwards upstream, settles the ledger
   ← upstream status + body, PAYMENT-RESPONSE: <base64 settlement>
```

Header names follow x402 v2 (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). Check them against the x402-foundation spec when implementing; if they differ, the spec wins and this doc gets updated.

**Shortcut:** an agent may send its key on the first gateway request with `X-Piko-Autopay: true`. Piko then runs steps 1–3 internally and returns the upstream response directly. The playground agent and the MCP server use this. The three-step flow exists for x402 compatibility and the demo.

### Challenge (the 402 body)
```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "paypal-ledger",
    "network": "paypal:sandbox",
    "maxAmountRequired": "2000",
    "asset": "USD-micro",
    "payTo": "priya",
    "resource": "https://<app>/g/priya/history",
    "description": "Price history for one product",
    "nonce": "c_01J…",
    "expiresAt": "2026-11-10T12:00:30Z",
    "facilitator": "https://<app>/api/facilitator"
  }]
}
```
The price shown is already the buyer org's **enterprise rate** if one exists. Free-allowance calls skip the 402 entirely.

### Receipt
A JWT (HS256, `RECEIPT_SIGNING_SECRET`) with claims `{ nonce, agentId, orgId, sellerId, endpointId, amount, exp }`. It lasts `RECEIPT_TTL_SECONDS` and is **single-use**: settling marks `challenges.consumed_at`, and a second use is rejected.

### Settlement
After the upstream response:
- **2xx–4xx:** the Call is **paid**, and the three ledger entries are written in one transaction.
- **5xx or timeout (`UPSTREAM_TIMEOUT_MS`):** the Call is **refunded**. The reservation is released (or reversing entries are written), and the agent gets `502 { "error": { "code": "upstream_failed", "refunded": true } }`.

## 3. Public API (in openapi.yaml)

| # | Method + path | Who | Purpose |
|---|---|---|---|
| 1 | `ANY /g/{seller}/{path}` | Agent | Hosted gateway: 402 challenge, or the proxied upstream response |
| 2 | `POST /api/pay` | Agent | Run policy, budget and breaker checks and issue a receipt |
| 3 | `GET /api/approvals/{id}` | Agent | Poll an approval created by a policy |
| 4 | `GET /api/directory/search` | Agent | Semantic search over listings, with prices for the caller's org |
| 5 | `GET /api/wallet` | Agent | Balance, budgets left, frozen state for this key |
| 6 | `GET /api/facilitator/supported` | Anyone | Schemes and networks Piko settles |
| 7 | `POST /api/facilitator/verify` | Seller | Check a receipt without consuming it |
| 8 | `POST /api/facilitator/settle` | Seller | Consume a receipt and settle (for sellers not behind the hosted gateway) |

## 4. Errors

Every error body is `{ "error": { "code": "...", "message": "...", ...details } }`. `/api/pay` checks in this order and returns the first failure:

| Status | `code` | Meaning | Details |
|---|---|---|---|
| 401 | `invalid_key` | Missing, wrong or revoked key | — |
| 423 | `agent_frozen` | Kill switch is on for the agent, its team or its org | `scope` |
| 429 | `breaker_tripped` | Circuit breaker froze the agent just now | `calls`, `windowSeconds` |
| 403 | `policy_denied` | A policy blocks this vendor or price | `policyId`, `rule` |
| 202 | `approval_pending` | Needs a human; poll the approval | `approvalId`, `approvalUrl` |
| 402 | `budget_exceeded` | Agent, team or org budget is used up | `scope`, `remaining` |
| 402 | `insufficient_funds` | Prepaid balance or org credit limit is too low | `balance` |
| 410 | `challenge_expired` | Nonce expired or already used | — |

## 5. MCP server

`POST /mcp/{seller}` uses the MCP Streamable HTTP transport and the official TypeScript SDK.
- **Auth:** the agent key in `Authorization: Bearer …`, configured once in the MCP client (Claude Desktop, Cursor).
- **Tools:** one per seller endpoint. The name and description come from the listing, and the input schema comes from the endpoint's parameters. **Each tool's description includes its price**, so the model sees the cost before calling it.
- **A tool call** runs the autopay path (§2) and returns the upstream result. A short line ("Charged $0.002 via Piko") is added to the content.
- **Errors** from §4 come back as MCP tool errors with the same `code`. `approval_pending` includes the approval URL so a human can act on it.

## 6. Internal dashboard routes (not in openapi.yaml)

| Route | Purpose |
|---|---|
| `POST /api/topups` → `POST /api/topups/{orderId}/capture` | Create and capture a PayPal Order for a wallet top-up |
| `POST /api/checkout/demo-product` → capture | The end-of-demo monitor purchase (Orders with `payee` = demo shop) |
| `POST /api/policies/compile` | Gemini: plain English → policy JSON (not saved) |
| `POST /api/policies` / `POST /api/policies/{id}/confirm` | Save and activate a compiled policy |
| `POST /api/approvals/{id}/decide` | Approve or deny |
| `POST /api/freeze` / `POST /api/unfreeze` | Kill switch for an agent, team or org |
| `CRUD /api/orgs/{id}/teams`, `/agents`, `/keys`, `/budgets` | Org structure |
| `POST /api/listings` | Create a listing from a base URL (+ optional OpenAPI/docs text) |
| `POST /api/listings/{id}/suggest-pricing` | Gemini pricing assistant |
| `CRUD /api/endpoints`, `/api/rate-overrides` | Prices and enterprise rates |
| `POST /api/payouts/withdraw` | Manual seller payout |
| `POST /api/invoices/generate` | Build and send an org's monthly PayPal invoice now |
| `POST /api/paypal/webhook` | PayPal events (idempotent on resource id) |
| `GET /api/stream/calls` | Server-sent events for live call feeds |
| `POST /api/demo/simulate` | Start or stop simulated traffic (demo mode only) |
| `GET /api/demo/sellers/product-search/search?q=…` | Product Search sample API; queries Channel3 server-side and returns the fixed monitor fallback when unavailable or empty |
| `GET /api/demo/sellers/price-history/history?product=…` | Price History sample API; returns 90 deterministic daily points for a product ID |
| `/api/demo/sellers/*` | Other sample seller APIs (see SEED_DATA.md) |

Product Search returns `{ "products": [...], "source": "channel3" | "fallback" }`. Its Channel3 API key stays server-side. Price History returns `{ "productId": "…", "currency": "USD", "history": [{ "date": "YYYY-MM-DD", "priceMicroUsd": "…" }] }`; the fixed window and integer micro-USD values are deterministic for each product ID.
