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

## 2. The paid-call flow (x402 v2)

Piko speaks x402 v2 over HTTP ([core spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md)) with its own scheme `paypal-ledger` on network `paypal:sandbox`. The reasons and sources are in [decision 0011](decisions/0011-x402-v2-and-gemini-model.md).

```
1. Agent → GET /g/{seller}/{path}            (no payment header)
   ← 402  PAYMENT-REQUIRED: base64(PaymentRequired)  + the same object as the JSON body

2. Agent → POST /api/pay  { nonce }          (Authorization: agent key)
   ← 200 { receipt, paymentSignature, … }     or an error from §4

3. Agent → GET /g/{seller}/{path}  PAYMENT-SIGNATURE: base64(PaymentPayload)
   Piko verifies the receipt, forwards upstream, then settles the ledger and consumes the receipt
   ← upstream status + body, PAYMENT-RESPONSE: base64(SettlementResponse)
```

All three headers carry **base64-encoded JSON** (standard base64 of the UTF-8 JSON text). The names are the x402 v2 ones, confirmed against the spec: `PAYMENT-REQUIRED` (server → client), `PAYMENT-SIGNATURE` (client → server), `PAYMENT-RESPONSE` (server → client). The v1 names `X-PAYMENT` / `X-PAYMENT-RESPONSE` are not used. Per the spec, the header is the canonical location; the JSON body copy on the 402 is a Piko convenience.

**CORS:** for browser callers, the gateway exposes `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` in `Access-Control-Expose-Headers`, allows `PAYMENT-SIGNATURE`, `Content-Type`, `Authorization`, `X-Piko-Autopay` and `Idempotency-Key` in `Access-Control-Allow-Headers`, and answers the `OPTIONS` preflight without asking for payment.

**Shortcut:** an agent may send its key on the first gateway request with `X-Piko-Autopay: true`. Piko then runs steps 1–3 internally and returns the upstream response directly. The playground agent and the MCP server use this. The three-step flow exists for x402 compatibility and the demo. Any error from §4 comes back as that error, for example `402 insufficient_funds`, and nothing is forwarded. Without a Key it returns `401 invalid_key`. A free-allowance Call stays free. Only the exact value `true` (any case) turns it on; any other value is an ordinary request and gets the 402.

- **Retries and `Idempotency-Key`.** Without a key, every autopay request is a new Challenge, so a client that loses a paid response and retries pays twice. Send `Idempotency-Key: <1–255 chars>` to make the retry safe. The key, scoped to the agent and the Endpoint, picks the Challenge, so a retry with the same key reuses it: if that Challenge was already paid, the retry gets `409 idempotent_replay` with `callId` and `upstreamStatus` and nothing is charged or forwarded (Piko does not store upstream bodies, so it can't replay one); while the first request is still being served it gets `409 idempotency_in_progress`; if the first one stopped before reserving (for example `402 insufficient_funds`), the retry pays that same Challenge. If the first one failed after reserving (a 5xx, a timeout or a 408), its Challenge is expired, so the retry gets `410 challenge_expired`; send a new key to try again. A free-allowance Call ignores the key. The header is forwarded to the seller like any other.
- **Approvals (Phase 5, P5-04).** With autopay the agent never sees the Challenge nonce, so it couldn't finish a payment that a human approves. When P5-04 adds `202 approval_pending`, an autopay 202 must include the Challenge `nonce` alongside `approvalId` and `approvalUrl`, so that once the approval is granted the agent can `POST /api/pay` with that nonce and retry with `PAYMENT-SIGNATURE`, or repeat the autopay request with the same `Idempotency-Key`. No pay step returns 202 yet.
- **Slow uploads.** The request body is read after the funds are reserved, but the gateway claims the hold first and stretches it to cover the body deadline, the upstream timeout and settling, so a slow upload hits `408 request_timeout` (nothing charged), never the receipt's expiry.

### Challenge (`PaymentRequired`, the 402)
```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://<app>/g/priya/history",
    "description": "Price history for one product",
    "mimeType": "application/json",
    "serviceName": "Price History"
  },
  "accepts": [{
    "scheme": "paypal-ledger",
    "network": "paypal:sandbox",
    "amount": "2000",
    "asset": "USD",
    "payTo": "priya",
    "maxTimeoutSeconds": 60,
    "extra": {
      "decimals": 6,
      "nonce": "c_01J…",
      "expiresAt": "2026-11-10T12:00:30Z",
      "facilitator": "https://<app>/api/facilitator",
      "payUrl": "https://<app>/api/pay"
    }
  }]
}
```
- `resource` is an object (`ResourceInfo`) at the top level, not a string inside `accepts[]`. `description` lives there.
- `amount` (not v1's `maxAmountRequired`) is in the asset's atomic unit. For `paypal-ledger` that is **micro-USD** (`asset` is the ISO 4217 code `USD`, and `extra.decimals: 6` says so explicitly), so `"2000"` is **$0.002**.
  - **This deviates from the precedent.** The spec's `cloudflare:402` binding uses the same `asset: "USD"` with `amount` in cents, where `"2000"` would be $20.00. We use micro-USD because per-call prices are fractions of a cent. A client must read `extra.decimals` (or know `paypal-ledger`) before it shows or compares a price. See [decision 0011](decisions/0011-x402-v2-and-gemini-model.md).
- `payTo` is the seller slug. `maxTimeoutSeconds` is required by the spec and equals `RECEIPT_TTL_SECONDS`.
- Piko-specific fields go in `extra`, which the spec reserves for scheme-specific data: the challenge `nonce`, its `expiresAt`, the `facilitator` base URL and the `payUrl` that issues receipts. `extra.paymentFlow` is omitted, which means the default `authorization` flow (verify → resource → settle).

The price shown is already the buyer org's **enterprise rate** if one exists.

**Free allowance.** A free Call needs the agent's Key on the request, because the Key identifies the buyer. While the buyer org has made fewer free Calls to an endpoint than its quota, the gateway skips the 402, forwards the request and records a `free` Call of amount 0 with no Ledger entries. A free Call whose upstream fails (5xx or timeout) returns `502 upstream_failed` with `refunded: false`, charges nothing, and does not use up the quota. Seeded `simulated` Calls never count toward the quota.

**$0 endpoints.** An endpoint priced at 0 never gets a 402, so a Challenge always has a positive amount. The gateway forwards every request like a free Call, with no quota. With a Key it records a `free` Call of amount 0 (no Ledger entries); with no Key it forwards without recording a Call, since there is no buyer to record it against. A failed upstream returns `502 upstream_failed` with `refunded: false`.

**Upstream redirects.** The gateway does not follow upstream redirects, and it never passes the seller's base URL back. A `Location` or `Content-Location` under the listing's base URL is rewritten to the matching root-relative `/g/{seller}/...` path; one elsewhere on the upstream's origin is dropped; one on another origin passes through unchanged.

**Challenge cleanup.** About one 402 in ten also deletes up to 100 Challenges that expired over 5 minutes ago and were never reserved (and that no Call or Approval references). Within those 5 minutes a late payment still gets `410 challenge_expired`; after that the nonce is unknown.

**Gateway errors.** An unknown seller or route returns `404 not_found`. A Key that is sent but wrong returns `401 invalid_key`, and a frozen agent's Key returns `423 agent_frozen`; a request with no Key gets the 402. A Challenge issued with a Key can only be paid by that same buyer org.

### Receipt and payment payload
The receipt is a JWT (HS256, `RECEIPT_SIGNING_SECRET`) with claims `{ nonce, agentId, orgId, sellerId, endpointId, amount, exp }`. It lasts `RECEIPT_TTL_SECONDS` and is **single-use**: settling marks `challenges.consumed_at`, and a second use is rejected.

The agent does not send the bare JWT. It sends an x402 `PaymentPayload` with the receipt as the scheme-specific `payload`, base64-encoded in `PAYMENT-SIGNATURE`. `POST /api/pay` returns this ready-made as `paymentSignature`, so a client can copy it into the header.
```json
{
  "x402Version": 2,
  "resource": { "url": "https://<app>/g/priya/history" },
  "accepted": { "scheme": "paypal-ledger", "network": "paypal:sandbox", "amount": "2000", "asset": "USD", "payTo": "priya", "maxTimeoutSeconds": 60, "extra": { "decimals": 6, "nonce": "c_01J…", "expiresAt": "2026-11-10T12:00:30Z", "facilitator": "https://<app>/api/facilitator", "payUrl": "https://<app>/api/pay" } },
  "payload": { "receipt": "eyJhbGciOiJIUzI1NiJ9…" }
}
```
`accepted` must equal one of the offered `accepts[]` entries, and the receipt's `nonce` and `amount` must match it.

**Retrying `/api/pay`.** Paying is safe to retry. If the same agent pays the same nonce again while its hold is active and before the gateway (or facilitator) has started using it, `/api/pay` returns the same receipt with the same `expiresAt` and holds the amount only once. Another agent of the same org gets `410 challenge_expired`, and an agent of another org gets `403 challenge_buyer_mismatch`. Once a Call has started on the receipt, a retry gets `410`.

### Settlement (`SettlementResponse`, the `PAYMENT-RESPONSE` header)
Before forwarding, the gateway **claims** the receipt's reservation in one atomic update. Only one request per receipt gets past the claim, across every server process; the others get `410 challenge_expired` and never reach the seller. The claim only matches the hold the receipt was issued for (its `exp` is that hold's expiry, to the second), so a receipt from an earlier hold on the same Challenge is rejected. The claim also extends the hold to cover reading the body, the upstream call and settling, so the seller never runs on a hold that has run out.

The request body must arrive within the body deadline (`UPSTREAM_TIMEOUT_MS`). If it doesn't, nothing is forwarded or charged, the reservation is released as below, and the agent gets `408 request_timeout`. A free Call's slow upload gets the same 408 and does not use up the quota.

After the upstream response:
- **2xx–4xx:** the Call is **paid**, and the three ledger entries are written in one transaction. The header decodes to:
  ```json
  { "success": true, "transaction": "call_01J…", "network": "paypal:sandbox", "payer": "agent_01J…", "amount": "2000" }
  ```
  `transaction` is the Piko Call id (there is no blockchain hash) and `payer` is the agent id.
- **5xx or timeout (`UPSTREAM_TIMEOUT_MS`):** nothing settles, so the buyer is not charged. The reservation is released immediately and the agent gets `502 { "error": { "code": "upstream_failed", "refunded": true } }` with a `PAYMENT-RESPONSE` of `{ "success": false, "errorReason": "upstream_failed", "transaction": "", "network": "paypal:sandbox" }`. No Call is recorded yet (P8-01 decides that). Releasing also expires the Challenge, so the receipt can't be used again and `POST /api/pay` for that nonce returns `410 challenge_expired`; to retry, call the endpoint again for a new 402.

**Rejected payments.** A `PAYMENT-SIGNATURE` that fails verification gets `402 invalid_receipt` (malformed, wrong signature, tampered, or not for this endpoint and amount) or `410 challenge_expired` (expired, already used, in use by another request, or its reservation has ended). Neither reaches the seller. The `402 invalid_receipt` body is the standard error body (§4), not a Challenge, and has no `PAYMENT-REQUIRED` header.

## 3. Public API (in openapi.yaml)

| # | Method + path | Who | Purpose |
|---|---|---|---|
| 1 | `ANY /g/{seller}/{path}` | Agent | Hosted gateway: 402 challenge, or the proxied upstream response |
| 2 | `POST /api/pay` | Agent | Run policy, budget and breaker checks and issue a receipt |
| 3 | `GET /api/approvals/{id}` | Agent | Poll an approval created by a policy |
| 4 | `GET /api/directory/search` | Agent | Semantic search over listings, with prices for the caller's org |
| 5 | `GET /api/wallet` | Agent | Balance, budgets left, frozen state for this key |
| 6 | `GET /api/facilitator/supported` | Anyone | Schemes and networks Piko settles |
| 7 | `POST /api/facilitator/verify` | Anyone holding the `PaymentPayload` | Check a receipt without consuming it |
| 8 | `POST /api/facilitator/settle` | Anyone holding the `PaymentPayload` | Consume a receipt and settle (used by sellers not behind the hosted gateway) |

### Facilitator endpoints (x402 v2 shapes)
These follow the spec's facilitator interface (§7 of the core spec), so any x402 v2 resource server can use Piko as its facilitator for `paypal-ledger`.
- `GET /api/facilitator/supported` → `{ "kinds": [{ "x402Version": 2, "scheme": "paypal-ledger", "network": "paypal:sandbox" }], "extensions": [], "signers": {} }`. `signers` is empty because no on-chain key signs anything.
- `POST /api/facilitator/verify` and `POST /api/facilitator/settle` both take `{ "x402Version": 2, "paymentPayload": <PaymentPayload>, "paymentRequirements": <PaymentRequirements> }`.
- `verify` is **read-only** and returns `{ "isValid": true, "payer": "agent_01J…" }` or `{ "isValid": false, "invalidReason": "challenge_expired", "invalidMessage": "…" }`.
- `settle` consumes the receipt, writes the ledger entries and returns a `SettlementResponse` (as in §2). A seller calls it only after its handler succeeds (the `authorization` flow). If it never calls it, the reservation is released when the receipt expires, so nothing is charged.
- Every `settle` answer is a `SettlementResponse`, failures included, so an x402 SDK can parse it. A receipt that is expired or already used gets `410 { "success": false, "errorReason": "challenge_expired", "errorMessage": "…", "transaction": "", "network": "paypal:sandbox" }`, and `verify` returns `isValid: false` with `invalidReason: "challenge_expired"`. Any other failure of `settle` returns 200 with `success: false` and `errorReason: "invalid_receipt"`.
- A request body the facilitator can't use gets a 400 with x402's error codes: `invalid_payload` (not a JSON object, or no `paymentPayload`), `invalid_x402_version` (`x402Version` is not 2) or `invalid_payment_requirements` (`paymentRequirements` is not an object). The body is `{ "isValid": false, "invalidReason", "invalidMessage" }` from `verify` and a `SettlementResponse` with that `errorReason` from `settle`.
- Both routes check that `paymentRequirements` and `paymentPayload.accepted` are exactly what the Challenge offered. The expected requirements are rebuilt from the current config (`RECEIPT_TTL_SECONDS`, `APP_BASE_URL`, `PAYPAL_ENV`), so changing one of these between pay and settle makes receipts already issued read as `invalid_receipt`.
- **Neither route needs a key: the receipt is the credential.** It is single-use and bound to one Challenge's seller (`payTo`) and amount, and the gateway strips `PAYMENT-SIGNATURE` before forwarding, so a seller never sees a hosted Call's receipt. Today every Challenge comes from the hosted gateway, so whoever holds a receipt (in practice, only the buyer) can settle a hosted Endpoint's Call here without the upstream ever being called. That only lets the buyer charge themselves for nothing; it can't move anyone else's money.
- **Settling here while the gateway is forwarding the same receipt:** the gateway's claim on the hold does not stop this route, so the settle here succeeds, the buyer is charged once, and the gateway's own settle then fails, answering `410 challenge_expired` and dropping the upstream response. If this route settles first, the gateway's claim fails and it answers `410` without calling upstream.

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
| 410 | `challenge_expired` | Nonce expired or already used | — |
| 402 | `insufficient_funds` | Prepaid balance or org credit limit is too low | `balance`: micro-USD available |

`/api/pay` also returns these, which are not checks in the order above:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | The body is not JSON with a string `nonce` |
| 404 | `not_found` | No Challenge has this nonce |
| 403 | `challenge_buyer_mismatch` | The Challenge was issued with a Key from a different buyer org, or another org has already reserved it |
| 500 | `internal_error` | Something unexpected failed. The cause is logged on the server, never returned |

The gateway never issues a $0 Challenge (a $0 endpoint is forwarded free, see §2), so `invalid_amount` from `/api/pay` only means bad data.

`POST /api/pay` must see the challenge before the funds check, so a stale nonce gets 410 even with an empty wallet.

An autopay gateway request (§2) returns the `/api/pay` errors above, plus these for `Idempotency-Key`:

| Status | `code` | Meaning | Details |
|---|---|---|---|
| 400 | `invalid_request` | `Idempotency-Key` is empty or longer than 255 characters | — |
| 409 | `idempotent_replay` | A request with this key was already paid; nothing was charged again | `callId`, `upstreamStatus` |
| 409 | `idempotency_in_progress` | A request with this key is still being served | — |

## 5. MCP server

`POST /mcp/{seller}` uses the MCP Streamable HTTP transport and the official TypeScript SDK.
- **Auth:** the agent key in `Authorization: Bearer …`, configured once in the MCP client (Claude Desktop, Cursor).
- **Tools:** one per seller endpoint. The name and description come from the listing, and the input schema comes from the endpoint's parameters. **Each tool's description includes its price**, so the model sees the cost before calling it.
- **A tool call** runs the autopay path (§2) and returns the upstream result. A short line ("Charged $0.002 via Piko") is added to the content.
- **Errors** from §4 come back as MCP tool errors with the same `code`. `approval_pending` includes the approval URL so a human can act on it.
- **x402 over MCP (optional, not in the build order):** to serve x402-native MCP clients, follow the x402 v2 MCP transport ([spec](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md)). An unpaid call returns a tool result with `isError: true` and the `PaymentRequired` object in `structuredContent` (and as JSON text in `content[0].text`). The client retries with the `PaymentPayload` in `params._meta["x402/payment"]`, and the result carries the `SettlementResponse` in `_meta["x402/payment-response"]`. MCP uses plain JSON objects there, not base64.

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
| `POST /api/playground/run` | Signed-in buyer. Runs the playground agent with a per-run Key (revoked when the run ends). Body `{ "prompt": string }`, 1 to 500 characters. Response is `text/event-stream` of `data: <json>` frames whose `type` is one of `start` (`agent`, `budgetMicro`), `reasoning`, `answer`, `tool-call`, `tool-result` (`costMicro`, `ok`), `busy`, `error`, `done` (`spentMicro`, `recommendation`); `done` is always last. Errors, in the standard `{ "error": { "code", "message" } }` body (§4): `401 unauthenticated`, `400 invalid_request`, `409 no_agent`, and `500 internal_error` if the run can't start (its Key is revoked) |
| `POST /api/demo/simulate` | Start or stop simulated traffic (demo mode only) |
| `GET /api/demo/sellers/product-search/search?q=…` | Product Search sample API; queries Channel3 server-side and returns the fixed monitor fallback when unavailable or empty |
| `GET /api/demo/sellers/price-history/history?product=…` | Price History sample API; returns 90 deterministic daily points for a product ID |
| `POST /api/demo/sellers/review-summariser/summarise` | Review Summariser sample API (Priya Labs); Gemini summarises the reviews via `lib/llm` |
| `POST /api/demo/sellers/cheap-reviews/summarise` | Cheap Reviews sample API (DataCorp); same request and response as Review Summariser, but a terser prompt that reads only the first 5 reviews |

These are the upstreams the seeded listings point at (SEED_DATA.md §3); buyers reach them through `/g/{seller}/…`.

Product Search returns `{ "products": [...], "source": "channel3" | "fallback" }`. Its Channel3 API key stays server-side. Price History returns `{ "productId": "…", "currency": "USD", "history": [{ "date": "YYYY-MM-DD", "priceMicroUsd": "…" }] }`; the fixed window and integer micro-USD values are deterministic for each product ID.

Both review APIs take `{ "reviews": string | string[], "product"?: string }` (a string of up to 20,000 characters, or 1–50 non-empty reviews of up to 2,000 characters each; `product` up to 200 characters) and return `{ "product": string | null, "reviewCount": n, "sentiment": "positive" | "mixed" | "negative", "pros": string[], "cons": string[], "verdict": "…" }` (at most 5 pros and 5 cons; `reviewCount` is the number of reviews actually read). A bad body is `400 invalid_request`, and when every model in the `lib/llm` chain is busy they return `503 ai_busy` with the safe "AI is busy" message (standard error body, §4).
