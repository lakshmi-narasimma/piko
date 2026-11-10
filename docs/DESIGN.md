# Piko — Design Spec

> **Name:** Piko (chosen 2026-11-04). A pending "PIKO" US trademark in financial services exists. See [Open items](#19-open-items).
>
> **Status:** Agreed design, v1 · 2026-11-04
> **Hackathon:** PayPal AI Hackathon (Devpost) · submission deadline **Nov 12, 2026, 12:00pm PST** · judging Dec 1–15, 2026

---

## 1. One-line pitch

**Piko makes PayPal the default way AI agents pay, and get paid.**

Agents can already pay with Stripe or crypto. Piko brings them to PayPal: **one wallet** that developers and companies can control, and **one gateway** that turns any API or MCP tool into revenue, paid out to PayPal.

## 2. The problem

### Buyers (people and companies running AI agents)
- An agent that needs search, product data, maps and weather means **4 signups, 4 API keys, 4 cards, 4 bills**, usually with monthly minimums even for 50 calls.
- There is **no single budget** across all the APIs an agent uses.
- Companies are losing control of agent spend:
  - The FinOps Foundation's 2026 survey reportedly found 98% of organisations now manage AI spend.
  - Fewer than half know which agents they run (SAP LeanIX).
  - 94% of IT leaders worry about agent sprawl (OutSystems).
- Existing FinOps tools **report spend after it happens**. None of them **block a call before the money moves**.

### Sellers (people and companies with useful APIs or data)
- For a small API, building signups, API keys and billing isn't worth it.
- Large data owners can sign one-off licensing deals with AI companies (News Corp–OpenAI, reportedly $250M+ over 5 years). Everyone else can't.

### PayPal
- Stripe has agent payments (Machine Payments Protocol, MPP) and paid ~$1B for Metronome to do usage-based billing.
- x402 handles agent pay-per-call, but in crypto (USDC).
- **PayPal has no rail that lets agents pay per call.** Every paid-MCP-tool vendor today (Stripe MPP, Cloudflare `paidTool`, Apify, MCPize, xpay, FiatDock, Tollwicket) runs on Stripe or crypto.

## 3. What makes Piko different

1. **PayPal-native.** Money comes in and goes out through PayPal accounts, which 400M+ people and millions of merchants already have.
2. **Controls for the buyer's company.** Sub-budgets, plain-English policies, chargeback, kill switch and approvals, all **enforced in the payment path**. The paid-tool vendors above only serve sellers.
3. **One network, two sides.** The same wallet pays every seller on Piko, whether they sell an API or an MCP tool.

Not claimed as unique: no-code paywalls for MCP tools, and refunds when a call fails. Others have these. We include them because the product needs them, not as the innovation.

## 4. Users

| Persona | Side | Wants |
|---|---|---|
| **Solo dev buyer** ("Sam's agent builder") | Wallet | One wallet, one key, one hard budget for every API their agent uses |
| **Org admin buyer** ("Acme platform/finance lead") | Wallet | Per-team and per-agent budgets, policies, approvals, kill switch, spend per team, one monthly invoice |
| **Solo dev seller** ("Priya", indie API developer) | Gateway | Make an API paid in minutes, get paid to PayPal |
| **Org seller** (data company or publisher) | Gateway | Sell data to agents, custom rates for big buyers, traffic analytics |

## 5. Product overview

```
        BUYERS (Piko Wallet)                       SELLERS (Piko Gateway)
  ┌──────────────────────────────┐           ┌───────────────────────────────┐
  │ Solo dev: one wallet, budget │  calls →  │ Solo dev: put a price on an   │
  │ Org: sub-budgets, policies,  │  ← data   │ API or MCP tool in 2 minutes  │
  │ approvals, kill switch,      │           │ Org: custom rates, analytics  │
  │ monthly invoice              │           │                               │
  └──────────────┬───────────────┘           └───────────────┬───────────────┘
                 │       Piko ledger · x402 · directory     │
      PayPal Orders / Invoicing in              PayPal Payouts out
```

### 5.1 Wallet (buyer side)

**Solo dev**
- Top up with the PayPal button (Orders v2, capture). The ledger is credited.
- Wallet balance, hard budget per task or day, a "notify me above $X per call" threshold.
- API keys. Each key belongs to one agent.
- Live call feed.

**Organisation** (all six features are in the MVP, kept thin)
- **(a) Sub-budgets:** org → team → agent, each with a monthly cap.
- **(b) Policies:**
  - Vendor allowlist and blocklist, max price per call, and human approval above an amount.
  - The admin writes the policy in **plain English**, and Gemini compiles it into a structured rule. The UI shows the rule that was generated.
- **(c) Spend dashboard:** spend per team, agent, vendor and day (AG Grid).
- **(d) Audit log export:** CSV export from the grid.
- **(e) Kill switch:** per agent, per team or org-wide, plus the automatic circuit breaker (§9).
- **(f) Monthly invoice:**
  - Organisations are billed afterwards through **PayPal Invoicing v2**, not by topping up.
  - The demo includes a "Generate this month's invoice now" button.

### 5.2 Gateway (seller side)
- **Hosted gateway, no code:**
  - The seller pastes their API's base URL and gets `https://<app>/g/<seller-slug>/...`.
  - Piko proxies each request, enforces payment and forwards the request to the seller's API.
- **MCP wrapper:** Piko runs an MCP server that exposes the seller's listed endpoints as **paid MCP tools**, so Claude Desktop, Cursor and others can pay through Piko. This is a demo moment, not the innovation claim.
- **Pricing:** a price per endpoint (or per tool), a free allowance per buyer, and volume tiers (kept simple).
- **AI pricing help:** the seller pastes docs or an OpenAPI spec. Gemini suggests per-endpoint prices and writes the directory listing.
- **Enterprise rates:** a per-buyer-org price override table ("Acme pays $0.003, everyone else $0.005").
- **Analytics:** calls, revenue per endpoint, top calling agents and orgs, and how many 402 responses turn into paid calls.
- **Automatic refunds:** if the seller's upstream returns 5xx or times out, the buyer's charge is reversed on the ledger.
- **Payouts:** automatic once the balance reaches **$1.00**, plus a manual "Withdraw" button, through PayPal Payouts.

### 5.3 Directory
A searchable list of every listed API and MCP tool, with name, description, price per call, rating and seller. Search uses **Gemini embeddings + Postgres** (pgvector on Neon if available, or in-app cosine similarity as a fallback). The buyer agent searches the directory to choose tools.

### 5.4 Agent playground (the star of the demo)
- A chat UI with a Gemini shopping agent. Example prompt: *"Find me the best 4K monitor under $300 that's actually in stock."*
- It shows the agent's **reasoning about cost** ("worth $0.002 because…"), every paid call ticking by live, and the running total against the budget.
- It ends with a **real PayPal checkout** for the product (Orders v2 / JS SDK v6).

## 6. Core concepts (glossary)

| Term | Meaning |
|---|---|
| **Account** | A logged-in user (a person). |
| **Org** | A buyer and/or seller organisation. Solo devs get a personal org of one. |
| **Team** | A group of agents inside an org that has a budget. |
| **Agent** | A named automated caller. It holds one or more **keys**. |
| **Key** | A secret that identifies an agent to Piko. |
| **Wallet** | The ledger balance belonging to an org: prepaid for solo devs, postpaid (invoiced) for orgs. |
| **Budget** | A spending cap on an org, team, agent or task, per period. |
| **Policy** | A structured rule set compiled from plain English, applied before each payment. |
| **Approval** | A pending human decision created when a policy says "ask". |
| **Seller** | An org that lists endpoints. |
| **Listing** | A seller's API or MCP server in the directory. |
| **Endpoint / Tool** | One priced operation (an HTTP route or an MCP tool). |
| **Price** | Cost per call in micro-USD. It may be overridden per buyer org (an **enterprise rate**). |
| **Challenge** | The 402 response describing the price and how to pay. |
| **Receipt** | A signed token proving a payment was authorised for one specific call. |
| **Call** | One paid request: challenge → receipt → upstream response. |
| **Ledger entry** | An append-only debit or credit. Balances are always sums of entries. |
| **Payout** | Money sent to a seller's PayPal through the Payouts API. |
| **Invoice** | An org's monthly bill through PayPal Invoicing. |
| **Platform fee** | Piko's 5% cut of each call. |

## 7. Money flows

**Unit:** all amounts are stored as **integer micro-USD** (1 USD = 1,000,000). Never use floats.

### 7.1 Solo dev top-up (prepaid)
```
Buyer clicks PayPal button → Orders v2 create (intent CAPTURE) → buyer approves in sandbox
→ server captures → webhook PAYMENT.CAPTURE.COMPLETED (and synchronous capture result)
→ ledger: credit buyer wallet +amount (idempotent on capture id)
```

### 7.2 One paid call (the x402 loop)
```
Agent ──GET /g/priya/history?item=… ──────────────▶ Piko gateway
Agent ◀─ 402 + challenge {price, payTo, scheme, nonce, expiry} ──
Agent ── POST /pay {challenge, key} ──────────────▶ Piko (policy + budget + breaker check)
          ◀── receipt (signed, single-use, bound to nonce) ── or 403 / 202 approval-pending
Agent ──GET … + PAYMENT header (receipt) ─────────▶ Piko gateway → verifies → forwards upstream
Agent ◀─ 200 data (or refund on 5xx) ─────────────
```
Ledger per successful call, as one transaction:
```
buyer wallet    −price
seller balance  +price × 0.95
platform        +price × 0.05     (rounding remainder goes to platform)
```
Nothing touches PayPal here. PayPal's fixed fee (~$0.09) makes per-call charges impossible, so per-call money lives only on the ledger.

### 7.3 Seller payout
```
seller balance ≥ $1.00 (or Withdraw clicked)
→ Payouts API batch (one item) to seller's PayPal email
→ ledger: debit seller balance (status pending) → webhook PAYMENT.PAYOUTS-ITEM.SUCCEEDED → settled
→ on failure webhook: reverse the debit
```

### 7.4 Org monthly invoice (postpaid)
```
Sum of org's call debits for the period → Invoicing v2 create + send (line items per team)
→ org pays in sandbox → webhook INVOICING.INVOICE.PAID → ledger: mark period settled
```
Orgs have a **credit limit**. If the invoice is unpaid past the limit, the org's keys are paused.

### 7.5 Refund on failure
Upstream 5xx or timeout (default 10 s) → reverse that call's three ledger entries → the agent receives a 502 with `refunded: true`.

## 8. x402-style protocol

Piko follows x402's shape (HTTP 402 → pay → retry with proof) and acts as the **facilitator** for a new payment scheme.

- **Scheme:** `paypal-ledger` · **network:** `paypal:sandbox` (or `paypal:live`). The network id follows the CAIP-2 `namespace:reference` shape that x402 v2 asks non-blockchain networks to use.
- **402 challenge** (x402 v2 `PaymentRequired`, base64 JSON in the `PAYMENT-REQUIRED` header and repeated as the body):
  ```json
  {
    "x402Version": 2,
    "resource": { "url": "https://<app>/g/priya/history", "description": "Price history for one product", "mimeType": "application/json" },
    "accepts": [{
      "scheme": "paypal-ledger",
      "network": "paypal:sandbox",
      "amount": "2000",
      "asset": "USD",
      "payTo": "priya",
      "maxTimeoutSeconds": 60,
      "extra": { "decimals": 6, "nonce": "c_8f…", "expiresAt": "2026-11-10T12:00:30Z", "facilitator": "https://<app>/api/facilitator", "payUrl": "https://<app>/api/pay" }
    }]
  }
  ```
  `amount` is in micro-USD (`extra.decimals: 6`). Piko's own fields live in `extra`, which x402 reserves for scheme-specific data.
- **Facilitator endpoints:** `GET /api/facilitator/supported`, `POST /api/facilitator/verify`, `POST /api/facilitator/settle`, with the x402 v2 request and response shapes (API.md §3). The hosted gateway calls these internally, and an external seller could call them too.
- **Receipt:** a JWT signed with a server key containing `{nonce, agentId, orgId, sellerId, endpointId, amount, exp}` (API.md §2). It's **single-use** (the nonce is stored and consumed on settle) and expires in 60 s. The agent sends it wrapped in an x402 `PaymentPayload` (`payload: { receipt }`).
- **Headers:** confirmed against the x402 v2 HTTP transport spec: `PAYMENT-REQUIRED` (402 → agent), `PAYMENT-SIGNATURE` (agent → gateway), `PAYMENT-RESPONSE` (gateway → agent, a `SettlementResponse` whose `transaction` is the Call id). All three are base64-encoded JSON.
- **Flow:** x402's default `authorization` flow (verify → call upstream → settle), which matches "refund on upstream failure".
- **Registration:** none is needed. x402 has no scheme or network registry; any string works, and clients skip `accepts[]` entries they don't understand. Getting `paypal-ledger` into the official repo is optional: open an issue, then a PR with `specs/schemes/paypal-ledger/scheme_paypal_ledger.md` from the template. Details in [decision 0011](decisions/0011-x402-v2-and-gemini-model.md).

## 9. Policy engine, budgets and circuit breaker

Order of checks inside `POST /pay`. The first failure stops the call:
1. Key is valid and the agent is not frozen (kill switch).
2. **Circuit breaker:** more than N calls in a sliding window (default **50 calls / 10 s per agent**) or more than **$X / minute** → freeze the agent, create an alert, return 429.
3. **Policies**, in order: vendor block/allow → max price per call → "approval above $Y" (creates an Approval and returns 202 `approval_pending`).
4. **Budgets:** agent → team → org for the current period. Any one exceeded → 402 `budget_exceeded`.
5. **Funds:** the prepaid wallet balance, or the org's remaining credit limit.
6. Create the receipt and reserve the amount. Ledger entries are written on settle.

**Plain-English → policy (Gemini, structured output).** Example input: *"Marketing agents can't spend more than $50 a month on search, and anything over 5 cents a call needs my OK."*
```json
{ "scope": {"team": "marketing"},
  "rules": [
    {"type": "budget", "category": "search", "period": "month", "maxMicroUsd": 50000000},
    {"type": "approval_above", "maxMicroUsd": 50000}
  ] }
```
The admin sees the compiled rule and must click **Confirm** before it takes effect. Gemini never enforces anything itself: **all enforcement is deterministic code.**

## 10. AI features (Gemini)

| Feature | Where | What the AI does | Guardrail |
|---|---|---|---|
| **Budget-aware buyer agent** | Playground | Searches the directory, weighs price against value and rating, picks tools, explains its choices, stops near the budget | Budgets and policies are enforced by Piko, not the model |
| **Policy compiler** | Org console | English → structured policy JSON | Admin confirms; schema-validated |
| **Seller pricing assistant** | Seller console | Reads docs/OpenAPI → suggests per-endpoint prices + writes the listing | Seller edits before publishing |
| **Directory embeddings** | Directory | Semantic search over listings | — |
| *(stretch)* Spend analyst | Org console | "Why did costs spike?" chat over spend data | Read-only |

**Model:** `gemini-3.6-flash` (stable, free tier) for text, tool calling and structured output. When it is busy, `lib/llm` tries `gemini-3-flash-preview`, then `gemini-3.5-flash-lite`, then Groq (`openai/gpt-oss-120b`, only if `GROQ_API_KEY` is set). Free-tier quotas are per project **and per model**, so this chain also widens the daily allowance. Embeddings use `gemini-embedding-2` at 768 dimensions. The model ids come from env (`GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_EMBEDDING_MODEL`, `GROQ_MODEL`). Pinned ids are used rather than `-latest` aliases, because `gemini-flash-latest` returned 503 on every try on 2026-11-05; env validation rejects `-latest` ids. All of this goes through the Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/groq`). See [decision 0011](decisions/0011-x402-v2-and-gemini-model.md) for limits and sources.

**How `lib/llm` falls back:**
- **Busy means** 429, 503, Groq's 498, 500/502/504, 408, 404 (a retired or unknown model id), no HTTP response at all, or no answer within 20 s (for a stream, no response start within 20 s). Google treats 408 and 5xx as transient and suggests switching model on 500, and 0011 saw a retired model return 404, so another model can help in each case.
- **Not busy:** 400, 401, 403, 422, a reply that fails the zod schema, and an abort by the caller. These are rethrown unchanged, because the next model would fail the same way.
- **The SDK's own retries are off** (`maxRetries: 0`). Otherwise each model would be retried twice with 2 s and 4 s backoffs before the chain moves on, and a judge would wait for it.
- **Tool loops are sticky:** once a model answers a step, the later steps of that call start from it.
- **Streams** fall back only until the response starts. A provider error after that reaches the caller as an `error` part.
- **When the chain is exhausted,** it throws `AiBusy` (`name: "AiBusy"`, `code: "ai_busy"`, a message safe to show, and `modelsTried`). It carries no prompt, key or provider error text. The UI shows the "AI busy" fallback (TEST_PLAN F9).
- **Embeddings have no fallback.** Groq has no embeddings, and another model or size would put vectors in a different space. A busy embedding model throws `AiBusy` straight away, and a vector of the wrong size is rejected.
- **Logs** name the model that answered and why each skipped model was skipped. They never include prompts or keys.

## 11. Architecture

```
                    Render (free web service)
┌──────────────────────────────────────────────────────────────┐
│ Next.js (TypeScript) — one app                               │
│  ├─ UI: landing, wallet, org console, seller console,        │
│  │      directory, playground                                │
│  ├─ /api/pay, /api/facilitator/*      (payments core)        │
│  ├─ /g/:seller/*                      (hosted gateway proxy) │
│  ├─ /mcp/:seller                      (paid MCP server)      │
│  ├─ /api/paypal/webhook               (PayPal events)        │
│  ├─ /api/demo/*                       (sample seller APIs +  │
│  │                                     simulated traffic)    │
│  └─ lib/: ledger, policy, breaker, x402, paypal, llm         │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
        Neon Postgres (free)        PayPal sandbox REST + webhooks
                                    Gemini API (free tier)
                                    Channel3 API (1k free calls/mo)
GitHub Action: ping every 10 min so the free instance stays awake during judging.
```

**Stack:**
- Next.js (App Router) and TypeScript
- Postgres on Neon, using Drizzle ORM over node-postgres ([decision 0012](decisions/0012-drizzle.md))
- Vercel AI SDK with the Gemini provider
- PayPal Agent Toolkit plus direct REST calls
- Official MCP TypeScript SDK
- AG Grid Community
- Tailwind CSS

**Auth:** a persona switcher for judges ("Log in as Sam / Acme admin / Priya"), plus simple email+password for real accounts. Judges should never have to sign up.

## 12. Data model

Defined in `lib/db/schema.ts`. `id` columns are UUIDs, and every `*_micro` column is a `bigint`.

```
accounts(id, email, name, password_hash, created_at)
orgs(id, name, slug, kind[personal|company], billing[prepaid|invoiced], credit_limit_micro, paypal_email, frozen_at, created_at)
memberships(account_id, org_id, role[admin|member])
teams(id, org_id, name, frozen_at, created_at)
agents(id, org_id, team_id, name, notify_above_micro, frozen_at, created_at)
api_keys(id, agent_id, hash, prefix, created_at, revoked_at)
budgets(id, org_id, scope_type[org|team|agent], scope_id, period[day|month|task], max_micro, category?, created_at)
policies(id, org_id, source_text, compiled_json, confirmed_at, created_at)
approvals(id, agent_id, org_id, policy_id?, challenge_nonce, amount_micro, status[pending|approved|denied], decided_by, decided_at, created_at)
listings(id, seller_org_id, slug, name, description, base_url, kind[http|mcp|both], category?, rating?, embedding, created_at)
endpoints(id, listing_id, method, path_or_tool, price_micro, free_quota, created_at)
rate_overrides(id, endpoint_id, buyer_org_id, price_micro)
challenges(nonce, endpoint_id, agent_id?, buyer_org_id?, amount_micro, expires_at, reserved_at, reservation_expires_at, consumed_at, created_at)
calls(id, nonce?, agent_id, buyer_org_id, endpoint_id, amount_micro, status[paid|free|refunded|blocked], block_reason?, upstream_status, latency_ms, simulated bool, created_at)
ledger_entries(id, txn_id, account_type[wallet|seller|platform], org_id?, amount_micro, reason[call|refund|topup|payout|payout_reversal|invoice_settlement|seed], ref_id, created_at)
topups(id, org_id, paypal_order_id, paypal_capture_id, amount_micro, status[created|completed|failed], created_at)
payouts(id, seller_org_id, paypal_batch_id, paypal_item_id, amount_micro, status[pending|settled|failed], created_at)
invoices(id, org_id, paypal_invoice_id, period, amount_micro, status[draft|sent|paid|cancelled], created_at)
alerts(id, org_id, agent_id?, type, message, created_at)
webhook_events(id, paypal_event_id, event_type, resource_id, payload, received_at, processed_at)
```
Rules:
- The ledger is **append-only**. Balances come from summing `ledger_entries`, with a cached balance column if performance needs it. A database trigger rejects `UPDATE` and `DELETE` on the table. `TRUNCATE` stays allowed so the demo seed can reset.
- A unique index on `(reason, ref_id, account_type)` means the same event can't post twice to one account.
- `ledger_entries.org_id` is null only for the platform account.
- Every PayPal webhook handler is **idempotent**, keyed on the PayPal resource id. `webhook_events` is unique on the event id and on `(event_type, resource_id)`.
- A **reservation** lives on the Challenge. It holds funds while `reserved_at` is set, `consumed_at` is null and `reservation_expires_at` is in the future. It needs no ledger entry, because entries are written on settle.
- A Challenge's `agent_id` and `buyer_org_id` are null when the 402 goes to a caller who sent no key. `POST /api/pay` fills them in.
- `orgs.slug` is the `<seller>` in `/g/<seller>/…` and `/mcp/<seller>`.
- `teams.frozen_at` and `orgs.frozen_at` back the kill switch at those levels.

## 13. PayPal integration map

| Need | PayPal product | Notes |
|---|---|---|
| Solo dev top-up | **Orders v2** (create → capture) + **JS SDK v6** button | Sandbox personal account as the buyer |
| Buying the product at the end of the demo | **Orders v2** / JS SDK v6 | A separate merchant (seeded "monitor shop") |
| Seller payouts | **Payouts API** | Check that sandbox Payouts is enabled on the business app |
| Org monthly bill | **Invoicing v2** | Line items per team |
| Event handling | **Webhooks** (capture completed, payout item succeeded/failed, invoice paid) | Verify signatures |
| Agent-facing PayPal tools | **Agent Toolkit** | Used in the playground agent for the final checkout and invoicing actions |
| *(if access granted)* | **Usage-based Billing** (limited release) | Would replace our own invoice calculation for orgs. Not depended on. |

**Sandbox accounts needed:**
- 1 business account (Piko platform)
- 2 business accounts (Priya and an org seller)
- 1 business account (monitor shop)
- 2 personal accounts (Sam, Acme's payer)

## 14. Sponsor tools (only where they do real work)

| Tool | Role |
|---|---|
| **Channel3** | Powers the sample "product search" seller API (1,000 free calls/month) |
| **AG Grid Community** | Call log, spend breakdown and seller analytics grids, plus CSV audit export |
| **APIMatic** | Generates the Piko buyer SDK from our OpenAPI spec (free plan: 1 API, ≤10 endpoints, 2 languages) |
| **Render** | Hosting |
| **Postman** | Public collection so judges can call the gateway and facilitator directly |
| ~~Elastic~~ | Dropped: the Cloud trial is 14 days and would expire before judging |

## 15. Screens

1. **Landing:** the pitch and two doors, *"I'm buying"* and *"I'm selling"*. A persona switcher for judges.
2. **Wallet** (solo dev): balance, PayPal top-up, budget, keys, live call feed.
3. **Org console:** team/agent tree, budgets, plain-English policies with the compiled rule, approvals inbox, kill switch, spend grid, invoices, alerts.
4. **Seller console:** connect an API (URL → gateway), AI pricing, endpoints, enterprise rates, analytics, payouts.
5. **Directory:** searchable APIs and MCP tools.
6. **Agent playground:** chat with the reasoning panel, live paid calls, budget meter, PayPal checkout at the end. **This screen gets the most polish.**

## 16. Real vs seeded

**Real (everything that touches money):**
- PayPal sandbox top-ups, payouts, invoices and checkout
- The x402 loop, the ledger, policies, budgets, the circuit breaker and the kill switch
- The gateway proxy and the MCP server
- The Gemini features

**Seeded:**
- **Three sample seller APIs**, built by us:
  - product search (Channel3)
  - review summariser (Gemini)
  - price history (synthetic data)
- The demo org **Acme**: 3 teams, 5 agents, policies.
- A **simulated agent fleet** generating background traffic so dashboards aren't empty. Every simulated call has `simulated = true` and is **labelled "simulated" in the UI**.

## 17. Build order

If time runs out, whatever is later in this list is cut first. Steps 1–6 alone are a complete demo.

1. Ledger (micro-USD, append-only), x402 challenge/receipt/settle loop, and the 3 sample seller APIs
2. PayPal top-up (Orders + JS SDK v6 + webhook) and the Wallet screen
3. Agent playground (Gemini agent + directory search + live call feed)
4. Hosted gateway proxy + Directory screen
5. Org budgets, policies (plain-English compiler), approvals, circuit breaker, kill switch
6. Seller console + PayPal Payouts
7. PayPal Invoicing for orgs
8. MCP wrapper, enterprise rates, automatic refunds, AI pricing assistant
9. Polish, seeding, deploy to Render, keep-awake ping, README, video

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Judges question demand for agent micropayments (CoinDesk, Mar 2026: "demand is just not there yet") | Lead with the **buyer and org-control pain**, which is provable today. Seller earnings are the bonus. |
| "Isn't this just Stripe MPP / x402?" | Answer: PayPal-native, org controls enforced at payment time, one two-sided network. |
| Holding prepaid balances counts as stored value or money transmission in real life | Say so openly. Production would run on PayPal's multiparty/marketplace setup, with PayPal holding the funds. |
| Gemini free-tier rate limits during judging | Cache playground runs; `llm` module can switch to Groq; graceful "AI busy" fallback. |
| Render free instance sleeps (30–60 s cold start) | GitHub Action keep-awake ping; README warns about it. |
| PayPal sandbox flakiness or slow webhooks | Use the synchronous capture result as primary, webhooks as confirmation. |
| An AI-compiled policy is wrong | Admin must confirm the compiled rule, the JSON schema is validated, and enforcement is deterministic code. |
| Scope has doubled since the first plan | Strict build order (§17). Each feature kept thin. |

## 19. Open items

- [ ] **Name risk.** "PIKO" has a pending US trademark (serial 99117355, Piko Labs AI, Inc., classes 36 financial services and 42 software). The npm name `piko` and the GitHub user `piko` are taken. Fine for a hackathon. Decide before taking Piko further as a product.
- [ ] **Demo video script.** Deferred until the build exists. Working scene order: problem → seller goes live → buyer tops up and agent buys → org policy, approval and kill switch → payout and invoice land → close.
- [ ] **Public GitHub repo + MIT licence.** Deferred. It must be public with the licence visible before submission.
- [ ] **PayPal Usage-based Billing access.** Ask on the PayPal hackathon Discord.
- [x] **x402 custom-scheme rules.** Done: there is no registry, and custom fiat schemes and networks are allowed (`cloudflare:402` with `USD` is a precedent in the spec). The v2 field names (`amount`, `resource` object, `extra`, `maxTimeoutSeconds`) are now in §8 and API.md. See decision 0011.
- [ ] **Confirm Payouts is enabled** on the sandbox business app.
- [x] **Confirm Gemini free-tier model and limits.** Done: `gemini-3.6-flash` first, then `gemini-3-flash-preview`, then `gemini-3.5-flash-lite`. Embeddings: `gemini-embedding-2` at 768 dimensions. Google publishes free-tier numbers only in AI Studio. Third-party tables give Flash 5 RPM / 20 RPD and Flash-Lite 10 RPM / 500 RPD. Before judging day, a human must read the real numbers from aistudio.google.com/rate-limit. See decision 0011.

## 20. Out of scope (this build)

- Organisations as sellers beyond custom rates and analytics, e.g. Cloudflare-style crawl monetisation of whole websites
- A code add-on for sellers' servers (Node/Python SDK); only the hosted gateway and MCP wrapper are in
- Auto-reload top-ups through PayPal Vault
- Real KYC, tax and multi-currency
- Mobile apps
