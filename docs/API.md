# Piko API

How agents, sellers and the dashboard talk to Piko. The machine-readable contract for the **public API** (agent- and seller-facing) is [openapi.yaml](../openapi.yaml). APIMatic generates the buyer SDK from it and the Postman collection is imported from it, so it must stay at **10 operations or fewer** (APIMatic free plan). Dashboard routes are internal and documented only here.

Amounts are always **integer micro-USD as strings** (`"2000"` = $0.002), so JavaScript clients never lose precision.

---

## 1. Authentication

| Caller | How |
|---|---|
| Agent | `Authorization: Bearer pk_agent_<secret>`: an agent **Key** created in the Wallet or Org console. Piko stores only a hash plus the visible prefix. |
| Seller upstream | No auth from Piko by default. Optionally, a seller sets a shared secret that Piko sends as `X-Piko-Secret` so their API can reject direct traffic. Any `X-Piko-Secret` a caller sends is dropped. The sample seller APIs under `${APP_BASE_URL}/api/demo/sellers/` get `DEMO_UPSTREAM_SECRET` (§6); no other upstream ever does. |
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

**Free allowance.** A free Call needs the agent's Key on the request, because the Key identifies the buyer. While the buyer org has made fewer free Calls to an endpoint than its quota, the gateway skips the 402, forwards the request and records a `free` Call of amount 0 with no Ledger entries. A free Call whose upstream fails (5xx or timeout) returns `502 upstream_failed` with `refunded: false`, charges nothing, and does not use up the quota: its Call row is removed, so no Call is recorded (nothing was charged, so there is nothing to refund). Seeded `simulated` Calls never count toward the quota.

**$0 endpoints.** An endpoint priced at 0 never gets a 402, so a Challenge always has a positive amount. The gateway forwards every request like a free Call, with no quota. With a Key it records a `free` Call of amount 0 (no Ledger entries); with no Key it forwards without recording a Call, since there is no buyer to record it against. A failed upstream returns `502 upstream_failed` with `refunded: false` and records no Call.

**Upstream SSRF re-check.** Before every upstream fetch (paid, autopay, free allowance and $0), the gateway runs the same SSRF guard as Listing creation (§6, `lib/gateway/ssrf`) on the full upstream URL, because the host's DNS may have changed since the Listing was saved. A URL it refuses (a host that now resolves to a loopback, private or link-local address, a host that no longer resolves within 3 seconds, a non-web port, or the app's own origin outside `/api/demo/sellers/`) is never fetched. It is treated as a failed upstream: `502 upstream_failed`, the hold is released and nothing is charged (`refunded: true` on a paid Call, `refunded: false` on a free one, whose quota is given back). The sample seller APIs under `${APP_BASE_URL}/api/demo/sellers/` skip the DNS lookup.

**Upstream redirects.** The gateway does not follow upstream redirects, and it never passes the seller's base URL back. A `Location` or `Content-Location` under the listing's base URL is rewritten to the matching root-relative `/g/{seller}/...` path; one elsewhere on the upstream's origin is dropped; one on another origin passes through unchanged.

**Upstream response headers.** The gateway answers on the app's own origin, so a seller's response must not act there. It drops any `Set-Cookie` from the upstream (a seller can never set or overwrite a Piko cookie) and sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` on every proxied response, replacing any the seller sent, so an HTML body can't run scripts as Piko.

**Challenge cleanup.** About one 402 in ten also deletes up to 100 Challenges that expired over 5 minutes ago and were never reserved (and that no Call or Approval references). Within those 5 minutes a late payment still gets `410 challenge_expired`; after that the nonce is unknown.

**Gateway errors.** An unknown seller or route returns `404 not_found`. A Key that is sent but wrong returns `401 invalid_key`, and a frozen agent's Key returns `423 agent_frozen`; a request with no Key gets the 402. The free allowance and $0 Endpoints check the kill switch too, again once the free Call is recorded, and give the free Call back if it is on. A Challenge issued with a Key can only be paid by that same buyer org.

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

**Kill switch on a held Receipt.** Once the claim is held, the gateway reads the agent's freeze state again (its own, its team's and its org's). If any is on, whether from an admin's freeze or a circuit-breaker trip after the Receipt was issued, the request gets `423 agent_frozen` with `scope`, nothing is forwarded or charged, and the reservation is released as below, so the Receipt can't be used again, even after an unfreeze. Any freeze that committed before the claim is seen. This covers autopay too.

The request body must arrive within the body deadline (`UPSTREAM_TIMEOUT_MS`). If it doesn't, nothing is forwarded or charged, the reservation is released as below, and the agent gets `408 request_timeout`. A free Call's slow upload gets the same 408 and does not use up the quota.

After the upstream response:
- **2xx–4xx:** the Call is **paid**, and the three ledger entries are written in one transaction. The header decodes to:
  ```json
  { "success": true, "transaction": "call_01J…", "network": "paypal:sandbox", "payer": "agent_01J…", "amount": "2000" }
  ```
  `transaction` is the Piko Call id (there is no blockchain hash) and `payer` is the agent id.
- **5xx, timeout (`UPSTREAM_TIMEOUT_MS`) or a refused upstream URL (see "Upstream SSRF re-check" above):** nothing settles, so the buyer is not charged. The reservation is released immediately and the agent gets `502 { "error": { "code": "upstream_failed", "refunded": true, "callId": "call_01J…" } }` with a `PAYMENT-RESPONSE` of `{ "success": false, "errorReason": "upstream_failed", "transaction": "", "network": "paypal:sandbox" }`. In the same transaction the gateway records the Call with status `refunded`: the Challenge's amount, the upstream's 5xx status (`upstream_status` is null after a timeout or when the upstream can't be reached) and the latency, but **no Ledger entries**, because in the `authorization` flow nothing was posted before the upstream answered. So the wallet balance after the refund equals the balance before, and the seller and platform get nothing. The 502 body also carries `callId`, the refunded Call's id (the header's `transaction` stays empty, as x402 has it for a failure). A Challenge has at most one Call, so a refund never records twice. If the receipt was settled through the facilitator while the upstream was failing, the buyer has paid and the gateway answers `410 challenge_expired` instead, as for any settle that lost that race. Releasing also expires the Challenge, so the receipt can't be used again and `POST /api/pay` for that nonce returns `410 challenge_expired`; to retry, call the endpoint again for a new 402. With autopay and an `Idempotency-Key`, a retry with the same key after a refund also gets `410 challenge_expired`, so the agent must use a fresh key.

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
- Every `settle` answer is a `SettlementResponse`, failures included, so an x402 SDK can parse it. A receipt that is expired or already used gets `410 { "success": false, "errorReason": "challenge_expired", "errorMessage": "…", "transaction": "", "network": "paypal:sandbox" }`, and `verify` returns `isValid: false` with `invalidReason: "challenge_expired"`. Any other failure of `settle` returns 200 with `success: false` and `errorReason: "invalid_receipt"`. If the kill switch is on for the paying agent, its team or its org, `verify` returns `isValid: false` with `invalidReason: "agent_frozen"` (and keeps the hold, being read-only), and `settle` returns `423` with `errorReason: "agent_frozen"`, charges nothing and releases the hold.
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
| 429 | `breaker_tripped` | Circuit breaker froze the agent just now | `reason` (`calls` or `spend`), `calls`, `windowSeconds`, `spentPerMinute`: micro-USD |
| 403 | `policy_denied` | A policy blocks this vendor or price | `policyId`, `rule` |
| 202 | `approval_pending` | Needs a human; poll the approval | `approvalId`, `approvalUrl` |
| 402 | `budget_exceeded` | This payment would take an agent, team or org budget over its cap | `scope`, `remaining`, `budgetId`, `period`, `category`, `max` |
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

The steps run in the order of docs/DESIGN.md §9: the Key, the kill switch, the Challenge lookup (`404`, `403 challenge_buyer_mismatch`), the circuit breaker, policies, budgets, then funds (where an expired or used Challenge gets `410` and low funds `402`), the breaker's recount (`429`), and the Receipt.

**Circuit breaker.** An agent trips it by paying for more than `BREAKER_MAX_CALLS` Calls in the last `BREAKER_WINDOW_SECONDS` (default 50 in 10 s), or more than `BREAKER_MAX_MICRO_PER_MINUTE` (default $2.00) in the last minute, counting the payment being made. What counts is every payment the agent reserved, whatever happened to it after (settled, refunded on an upstream failure, or never used); a retry of the same nonce counts once. A request stopped before the funds check reserves nothing and doesn't count, and free-allowance Calls never reach `/api/pay`. A trip freezes the agent, writes one `breaker_tripped` alert for the org and returns 429 with `calls` and `spentPerMinute` including this payment; the agent's next request gets `423 agent_frozen` until a human unfreezes it. The breaker counts again right after the funds check, so a concurrent burst can't get past it together: a request over the limit there also gets 429, and its hold is released, so nothing is charged. That recount can stop every request of a burst that crosses the limit at once.

**Kill switch.** An org admin freezes or unfreezes one agent, one team or the whole org from the Org console (a server action, not an HTTP route). While any of the three is on, the agent gets `423 agent_frozen` with the widest `scope` that is on (`org`, then `team`, then `agent`), on new payments and on Receipts it already holds (§2). Each change writes one alert for the org, type `frozen` or `unfrozen` (`agent_id` set for an agent, null for a team or the org); repeating a change is a no-op and writes nothing. Unfreezing an agent the breaker froze doesn't clear its window: its holds from the last `BREAKER_WINDOW_SECONDS` still count, so an immediate burst can trip it again.

**Budgets.** Every budget covering the paying agent is checked, the agent's first, then its team's, then its org's, and the first one the Challenge's amount doesn't fit in is reported. `scope` is `agent`, `team` or `org`; `period` is `day`, `month` or `task`; `category` is the listing category the budget is limited to, or `null` for all; `max` and `remaining` are micro-USD strings. `remaining` is what is left before this payment: `max` minus settled spend in the current period (net of refunds) minus every unsettled hold, never below `"0"`. A payment that exactly uses up `remaining` passes. Periods are UTC days and months, and the current one is found with the database clock, the same clock that stamps each Call. A `task` budget counts from when its cap was last changed: saving the same cap again, or changing only other limits, keeps the task going. Holds count so that concurrent payments can't both fit under one cap; a retry of a payment that already holds its amount isn't counted twice. A blocked payment writes a `budget_exceeded` alert for the org's admins, at most one per agent and budget in 10 minutes, so a looping agent doesn't flood the Alerts panel.

The gateway (`/g/{seller}/{path}`) and the facilitator's `verify` and `settle` also answer an unexpected failure with `500 internal_error` in this error body, logging the cause on the server. For the facilitator this is the one answer that is not an x402 response.

An autopay gateway request (§2) returns the `/api/pay` errors above, plus these for `Idempotency-Key`:

| Status | `code` | Meaning | Details |
|---|---|---|---|
| 400 | `invalid_request` | `Idempotency-Key` is empty or longer than 255 characters | — |
| 409 | `idempotent_replay` | A request with this key was already paid; nothing was charged again | `callId`, `upstreamStatus` |
| 409 | `idempotency_in_progress` | A request with this key is still being served | — |

## 5. MCP server

`POST /mcp/{seller}` uses the MCP Streamable HTTP transport and the official TypeScript SDK (`@modelcontextprotocol/sdk`). It is a JSON-RPC protocol endpoint defined by the MCP spec, so it is not in openapi.yaml (which also keeps that file inside its operation budget).
- **Stateless.** Every POST builds a fresh server, so there are no sessions (no `Mcp-Session-Id`) and responses are plain JSON, never an SSE stream. `GET` and `DELETE` get `405`.
- **Auth:** the agent key in `Authorization: Bearer …`, configured once in the MCP client (Claude Desktop, Cursor, the MCP Inspector). A missing, wrong or revoked Key is an HTTP `401 invalid_key` (the §4 body), before any MCP message is read. A frozen agent still connects; its tool calls fail with `agent_frozen`.
- **Seller:** `{seller}` is the seller org's slug, as in `/g/{seller}/…`. An unknown slug, or a seller with no Listing offered over MCP, is an HTTP `404 not_found`.
- **Tools:** one per Endpoint of the seller's Listings whose `kind` is `mcp` or `both` (`http` Listings are gateway-only). Endpoints whose method is `TOOL` are skipped until the gateway can forward to an MCP upstream.
  - **Name:** the method and path in lower case, with every run of other characters turned into `_`: `GET /history` is `get_history`, `POST /v1/summarise` is `post_v1_summarise`, `GET /` is `get_root`. A clash gets `_2`, `_3`, ….
  - **Description:** `<Listing name> (<METHOD> <path>): <Listing description> Price: $0.002 per call, paid from your Piko wallet.`, plus `Your first N calls are free.` when the Endpoint has a free allowance, or `Price: free.` for a $0 Endpoint. The model sees the cost before calling.
  - **Input schema:** `{ query?: { [name]: string | number | boolean } }`, plus `body?: <any JSON>` for POST, PUT and PATCH. `query` becomes the query string and `body` is sent as `application/json`. Endpoints have no parameter schema yet, so this is the same for every tool.
- **A tool call** is an autopay request (§2) to `/{METHOD} /g/{seller}/{path}` with the caller's Key, run in process through the same gateway code, so the free allowance, $0 Endpoints, the frozen check, the pay pipeline, forwarding, settling and the refund on an upstream failure all behave exactly as there. One tool call is one Challenge and at most one charge (three Ledger entries). The result is the upstream body as text (or as image content for an `image/*` response), followed by a line `Charged $0.002 via Piko (Call <callId>).`, or `Free call via Piko: nothing was charged.` for a free Call. An upstream 4xx is still a paid Call: the result has `isError: true` and the line starts `The upstream API answered 404.`
- **Errors** from §4 come back as MCP tool results with `isError: true`, never as HTTP or JSON-RPC errors. `content[0].text` is `<code>: <message>`, followed by the details as JSON on the next line, and `structuredContent` is the §4 body, for example `{ "error": { "code": "insufficient_funds", "message": "…", "balance": "0" } }`. An upstream 5xx or timeout gives `upstream_failed` with `refunded: true`: nothing was charged. `approval_pending` (once P5-04 adds it) will include the approval URL in its details, so a human can act on it.
- **Retries:** a tool call sends no `Idempotency-Key`, so a client that retries a call it already paid for pays again. The JSON-RPC request id can't be the key: in a stateless server ids are only unique per client connection and restart from 0.
- **x402 over MCP (optional, not in the build order):** to serve x402-native MCP clients, follow the x402 v2 MCP transport ([spec](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md)). An unpaid call returns a tool result with `isError: true` and the `PaymentRequired` object in `structuredContent` (and as JSON text in `content[0].text`). The client retries with the `PaymentPayload` in `params._meta["x402/payment"]`, and the result carries the `SettlementResponse` in `_meta["x402/payment-response"]`. MCP uses plain JSON objects there, not base64.

### Connecting a client

The URL is `https://<app>/mcp/<seller>`, for example `http://localhost:3000/mcp/priya`, and the Key is an agent Key from the Wallet console (or the one `npm run seed` prints for Sam).
- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, choose transport **Streamable HTTP**, enter the URL, and under **Authentication** add the header `Authorization` with the value `Bearer pk_agent_…`. Connect, then **Tools → List Tools**.
- **Claude Desktop:** it connects to remote servers through the `mcp-remote` bridge. In `claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "piko-priya": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "http://localhost:3000/mcp/priya",
                 "--header", "Authorization:${PIKO_KEY}"],
        "env": { "PIKO_KEY": "Bearer pk_agent_…" }
      }
    }
  }
  ```

  The header is passed through an environment variable because some clients split arguments on spaces. Restart Claude Desktop; the tools appear under the Piko server.
- **Cursor and other clients** that support remote servers with headers: `{ "url": "https://<app>/mcp/priya", "headers": { "Authorization": "Bearer pk_agent_…" } }`.

## 6. Internal dashboard routes (not in openapi.yaml)

| Route | Purpose |
|---|---|
| `POST /api/topups` → `POST /api/topups/{orderId}/capture` | Create and capture a PayPal Order for a wallet top-up |
| `POST /api/checkout/demo-product` → `POST /api/checkout/demo-product/{orderId}/capture` | Signed-in buyer. The end-of-demo monitor purchase (Orders with `payee` = demo shop). Body `{ "token": string }`: the `recommendation.checkoutToken` from the playground run's `done` event, and nothing else; the product name and price come from the token, never from the request. The token is `<base64url claims>.<base64url HMAC-SHA256>`, keyed from `SESSION_SECRET`, carrying the org, product name, price in micro-USD, link, a unique id and an expiry 30 minutes after the run. The route checks the signature, that the token was issued to the signed-in org and that it has not expired, then creates the order for the signed price (converted to PayPal's two-decimal string by `toPayPalValue`). The token's id is the order's `PayPal-Request-Id`, so sending one token again returns the same order rather than a second one. Response `{ "orderId" }`. Errors (standard body, §4): `401 unauthenticated`; `400 invalid_request` (no token); `400 invalid_checkout_token` (tampered, wrongly signed, or another org's); `400 checkout_token_expired`; `400 invalid_amount` (signed price outside $1 to $2,000 or not whole cents); `502 paypal_error` (`debugId`) |
| `POST /api/policies/compile` | Gemini: plain English → policy JSON (not saved) |
| `POST /api/policies` / `POST /api/policies/{id}/confirm` | Save and activate a compiled policy |
| `POST /api/approvals/{id}/decide` | Approve or deny |
| `POST /api/freeze` / `POST /api/unfreeze` | Kill switch for an agent, team or org |
| `CRUD /api/orgs/{id}/teams`, `/agents`, `/keys`, `/budgets` | Org structure |
| `POST /api/listings` | Create a Listing from a base URL, with its Endpoints and prices (see below). The pricing assistant reads the OpenAPI/docs text |
| `POST /api/listings/{id}/suggest-pricing` | Gemini pricing assistant |
| `CRUD /api/endpoints`, `/api/rate-overrides` | Prices and enterprise rates |
| `POST /api/payouts/withdraw` | Manual seller payout |
| `POST /api/invoices/generate` | Build and send an org's monthly PayPal invoice now |
| `POST /api/paypal/webhook` | PayPal events (idempotent on resource id) |
| `GET /api/stream/calls` | Server-sent events for live call feeds |
| `GET /api/stream/alerts` | Signed-in Org console admin only (`401 unauthenticated`; `403 forbidden` for a member or another area); always the session's own org. The Alerts panel and the nav badge. By default `text/event-stream`: one `snapshot` event `{ "alerts": [...], "unread": n }` with the latest 50 alerts, newest first, then an `alerts` event (an array, newest first) for each batch written after it; the server checks every second and sends a `: keep-alive` comment every 15 s. `?format=json` answers once with `{ "alerts", "unread", "cursor" }` (the polling fallback); pass that `cursor` back as `after` (JSON text) to get only newer alerts. `?format=count` answers `{ "unread": n }`. An alert is `{ id, type, agentId, agent, message, createdAt }`, where `agent` is the Agent's name or null and `type` is `breaker_tripped`, `budget_exceeded` or another type a later feature writes. `unread` counts alerts written after the `piko_alerts_seen` cookie's time (set by the panel's "Mark all read"), or in the last 24 hours when there is no cookie: the `alerts` table has no read column |
| `POST /api/playground/run` | Signed-in buyer. Runs the playground agent with a per-run Key (revoked when the run ends). Body `{ "prompt": string }`, 1 to 500 characters. Response is `text/event-stream` of `data: <json>` frames whose `type` is one of `start` (`agent`, `budgetMicro`), `reasoning`, `answer`, `tool-call`, `tool-result` (`costMicro`, `ok`), `busy`, `error`, `notice` (`text`), `done` (`spentMicro`, `recommendation`: `{ name, priceMicro, url?, checkoutToken }` or null, where `checkoutToken` is what the checkout route takes); `done` is always last. A replayed run gets a freshly signed `checkoutToken`. Replay: when the model is busy before the run has made any progress (no paid call has settled or is in flight) and the same org ran the same prompt within 10 minutes, the route sends `{ "type": "notice", "text" }` saying so, then replays the earlier run's events (ending with its `done`); no new charges are made and the replay is not cached again. Errors, in the standard `{ "error": { "code", "message" } }` body (§4): `401 unauthenticated`, `400 invalid_request`, `409 no_agent`, and `500 internal_error` if the run can't start (its Key is revoked) |
| `POST /api/demo/simulate` | Start or stop simulated traffic (demo mode only) |
| `GET /api/demo/sellers/product-search/search?q=…` | Product Search sample API; queries Channel3 server-side and returns the fixed monitor fallback when unavailable or empty |
| `GET /api/demo/sellers/price-history/history?product=…` | Price History sample API; returns 90 deterministic daily points for a product ID |
| `POST /api/demo/sellers/review-summariser/summarise` | Review Summariser sample API (Priya Labs); Gemini summarises the reviews via `lib/llm` |
| `POST /api/demo/sellers/cheap-reviews/summarise` | Cheap Reviews sample API (DataCorp); same request and response as Review Summariser, but a terser prompt that reads only the first 5 reviews |

These are the upstreams the seeded listings point at (SEED_DATA.md §3); buyers reach them through `/g/{seller}/…`. They answer only the gateway: each checks `X-Piko-Secret` against `DEMO_UPSTREAM_SECRET` (in constant time) before doing anything, and a request without it, or with a wrong value, gets `401 unauthorized` in the standard error body (§4), so nobody can spend the Gemini or Channel3 free tier by calling them directly. The gateway sends that secret only to upstream URLs under `${APP_BASE_URL}/api/demo/sellers/` (same scheme, host and port), never to another seller.

Product Search returns `{ "products": [...], "source": "channel3" | "fallback" }`. Its Channel3 API key stays server-side. Price History returns `{ "productId": "…", "currency": "USD", "history": [{ "date": "YYYY-MM-DD", "priceMicroUsd": "…" }] }`; the fixed window and integer micro-USD values are deterministic for each product ID.

Both review APIs take `{ "reviews": string | string[], "product"?: string }` (a string of up to 20,000 characters, or 1–50 non-empty reviews of up to 2,000 characters each; `product` up to 200 characters) and return `{ "product": string | null, "reviewCount": n, "sentiment": "positive" | "mixed" | "negative", "pros": string[], "cons": string[], "verdict": "…" }` (at most 5 pros and 5 cons; `reviewCount` is the number of reviews actually read). A bad body is `400 invalid_request`, and when every model in the `lib/llm` chain is busy they return `503 ai_busy` with the safe "AI is busy" message (standard error body, §4).

### Creating a Listing (`POST /api/listings`)
Only a signed-in admin of a seller org (the Seller console) can call it, and the Listing always belongs to their own org. Signed out gets `401 unauthenticated`; a Wallet or Org console account, or a seller member who is not an admin, gets `403 forbidden`.

```json
{
  "baseUrl": "https://api.example.com/v1",
  "name": "Weather Now",
  "description": "Current weather for a city.",
  "category": "weather",
  "kind": "http",
  "slug": "weather-now",
  "endpoints": [
    { "method": "GET", "path": "/forecast", "price": "0.002" },
    { "method": "POST", "path": "/bulk", "priceMicro": "10000", "freeQuota": 5 }
  ]
}
```
- `category`, `kind` (`http` default, `mcp`, `both`) and `slug` are optional. Without a `slug`, one is made from the name, with `-2`, `-3`… added if the seller already uses it. A `slug` the seller already uses gets `409 slug_taken`. `name` is up to 120 characters and `description` up to 500, since both reach buyers' agents verbatim.
- **At most 20 Listings per seller org.** A 21st gets `409 listing_limit` with `limit: 20`, and nothing is written.
- Each Endpoint has an HTTP `method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), a root-relative `path` (letters, digits, `.`, `_`, `~`, `-`; no query or `.`/`..` segments), and exactly one of `priceMicro` (whole micro-USD as a string) or `price` (dollars as typed, up to six decimals). A price is $0 to $100 per Call. `freeQuota` defaults to 0. 1 to 50 Endpoints, no route twice.
- **A route is unique per seller**, because the gateway URL `/g/{seller}/{path}` names no Listing. A route the seller already lists on another Listing gets `409 route_taken` with `method` and `path`, and nothing is written.
- The 409 checks (`listing_limit`, `slug_taken`, `route_taken`) run before the Listing is embedded, so a refused request spends no embedding call.
- **SSRF guard.** The base URL must be `http` or `https` on port 80 or 443 (another port gets `400 blocked_base_url` with `reason: "blocked_port"`), with no username, password, query or fragment. Its hostname is resolved (with a 3-second timeout) and refused with `400 blocked_base_url` if any address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, which holds the cloud metadata address), CGNAT (100.64/10), multicast, reserved or documentation space, or the IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped, NAT64 and 6to4 forms of a blocked IPv4 address). A host that doesn't resolve also gets `400 blocked_base_url` (`reason: "unresolvable_host"`). The one exception is the app's own `${APP_BASE_URL}/api/demo/sellers/…`, where the sample sellers live (the same prefix that gets `DEMO_UPSTREAM_SECRET`); it skips the DNS lookup. Any other URL on the app's origin is refused. Other bad URLs get `400 invalid_base_url`. The check is `lib/gateway/ssrf`, and the gateway runs it again before every forward (§2, "Upstream SSRF re-check").
- **Embedding.** The Listing is embedded for the Directory when it's created. If embedding fails (every model is busy, or any other error, which is logged), the Listing is still created, with `"embedded": false`, and the Directory embeds it on its next search.
- A bad body gets `400 invalid_request` with `issues: [{ path, message }]`.
- The Listing and its Endpoints are written in one transaction and are live on the gateway at once. The answer is `201 { "listing": { id, slug, name, description, category, kind, baseUrl, seller: { slug }, embedded, endpoints: [{ id, method, path, priceMicro, price, freeQuota, gatewayUrl }] } }`, where `gatewayUrl` is `${APP_BASE_URL}/g/{seller}{path}` and `price` is the display form (`"$0.002"`).
