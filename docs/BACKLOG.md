# Backlog

Every task Piko needs, grouped into phases that follow the build order in [DESIGN.md §17](DESIGN.md#17-build-order). Each task is one GitHub issue: one issue, one branch, one PR.

If time runs out, later phases are cut first. **Phases 0–6 alone make a complete demo.** Finish and test a phase before starting the next one.

---

## How we work

1. **Create the issue.** Copy one task from this file into a GitHub issue.
   - Title: the task's ID and name, e.g. `P1-03 Ledger: post a Call and refund it`.
   - Body: the task's **Goal**, **Done when** and **Depends on** lines.
   - Labels: the task's labels, plus its phase milestone.
2. **Work on it.** Make a branch named after the ID, e.g. `p1-03-ledger`. Read the docs the task links to before writing code.
3. **Open a PR.** Put `Closes #<issue number>` in the PR body. If you change an HTTP route, also update [API.md](API.md) and [openapi.yaml](../openapi.yaml) in the same PR.
4. **Merge.** Merge once CI is green and the task's **Done when** list is met. Tick the task here as `[x]`.

**Done means all of these:**
- Every **Done when** item is true.
- Lint, typecheck and tests pass in CI.
- The matching [TEST_PLAN.md](TEST_PLAN.md) flow passes for the parts this task covers.
- No secrets are committed. Any new environment variable is added to [.env.example](../.env.example).
- The money rules in [CLAUDE.md](../CLAUDE.md) hold: integer micro-USD, an append-only ledger and idempotent PayPal handlers.

### Labels
| Label | Meaning |
|---|---|
| `human` | Only a person can do it: PayPal dashboard, accounts, keys, video. Claude can't. |
| `core` | Payments core: ledger, x402, pay pipeline |
| `paypal` | Calls PayPal (Orders, Payouts, Invoicing, Webhooks, Agent Toolkit) |
| `ai` | Uses Gemini through `lib/llm` |
| `ui` | Screens and components |
| `infra` | Scaffold, CI, database, deploy |
| `docs` | Docs only |
| `research` | Read a spec or check something, then record the result |

### Milestones
One per phase: `P0 Setup`, `P1 Payments core`, … `P9 Ship`.

### Sizes
**S** is under 2 hours, **M** is half a day, **L** is a full day. Split anything bigger than L before starting.

---

## Phase 0: Setup

- [x] **P0-01 Create the GitHub repo and push the docs** · `human` `infra` · S
  - **Goal:** A private GitHub repo holding the current docs, with the labels and milestones above created.
  - **Done when:** The repo exists, `main` holds every doc, and the labels and milestones exist. *(It goes public with an MIT licence in P9-11.)*
  - **Depends on:** nothing

- [x] **P0-02 Set up the PayPal sandbox** · `human` `paypal` · M
  - **Goal:** Complete steps 1–3 of [PAYPAL_SETUP.md](PAYPAL_SETUP.md): the six sandbox accounts and the `piko` REST app with Payouts and Invoicing turned on. The tunnel and webhook (steps 4–5) moved to P2-05, because they need the running app.
  - **Done when:** The client id and secret are in `.env.local`, and the checklist items for the accounts and the REST app are ticked.
  - **Depends on:** nothing

- [x] **P0-03 Get the other keys and the database** · `human` `infra` · S
  - **Goal:** Get the Gemini key, the Channel3 key, a Neon database with `CREATE EXTENSION vector`, and the generated secrets (PAYPAL_SETUP.md steps 6–9).
  - **Done when:** `.env.local` has every value from `.env.example` except the webhook id and the Render URL.
  - **Depends on:** nothing

- [ ] **P0-04 Ask about Usage-based Billing on Discord** · `human` `research` · S
  - **Goal:** Find out whether hackathon teams can get access to PayPal's limited-release Usage-based Billing (PAYPAL_SETUP.md step 10).
  - **Done when:** The answer is recorded in [DESIGN.md §19](DESIGN.md#19-open-items).
  - **Depends on:** nothing

- [x] **P0-05 Confirm the x402 v2 details and the Gemini limits** · `research` `docs` · S
  - **Goal:** Read the x402-foundation `specs/` for v2 header names, payload shapes and the rules for a custom scheme. Confirm the current Gemini Flash model name, its free-tier limits, and the embedding model.
  - **Done when:** Any differences are fixed in API.md and openapi.yaml, and a decision record `0011` captures the findings.
  - **Depends on:** nothing

- [x] **P0-06 Scaffold the Next.js app** · `infra` · M
  - **Goal:** Set up Next.js (App Router) with strict TypeScript, Tailwind, ESLint, Prettier and Vitest. Add the `lib/` folders (`ledger`, `policy`, `breaker`, `x402`, `paypal`, `llm`, `db`), env validation with zod that fails fast on a missing variable, and the npm scripts `dev`, `build`, `lint`, `typecheck`, `test`, `db:migrate`, `seed`.
  - **Done when:** `npm run dev` serves a placeholder page, every script runs, and the "Run it locally" section of README is filled in.
  - **Depends on:** P0-01

- [x] **P0-07 Choose the ORM and connect the database** · `infra` · S
  - **Goal:** Pick Drizzle or Prisma ([DESIGN.md §11](DESIGN.md#11-architecture) left it open). Wire up Neon, the migrations, and a separate test database (a Neon branch or local Postgres) that the tests reset.
  - **Done when:** A decision record explains the choice, `db:migrate` runs on an empty database, and one test can write and read a row.
  - **Depends on:** P0-06, P0-03

- [x] **P0-08 Add CI** · `infra` · S
  - **Goal:** A GitHub Action that runs lint, typecheck and tests (with a Postgres service) on every PR.
  - **Done when:** A PR shows a green check, and a failing test turns it red.
  - **Depends on:** P0-07

---

## Phase 1: Payments core (ledger, x402 loop, sample APIs)
Covers TEST_PLAN **F1** and **F2**.

- [x] **P1-01 Create the full data model** · `core` `infra` · M
  - **Goal:** Write a migration for every table in [DESIGN.md §12](DESIGN.md#12-data-model). Amounts are `bigint` micro-USD. Add `calls.simulated` and a `webhook_events` table for idempotency. Add the indexes that balances and calls need.
  - **Done when:** The migration applies cleanly, and the schema matches §12. Any differences are written back into §12.
  - **Depends on:** P0-07

- [x] **P1-02 Money helpers** · `core` · S
  - **Goal:** Add a `MicroUsd` type, dollar parsing and formatting (display only), and the fee split from `PLATFORM_FEE_BPS`. The seller's share rounds down, and the remainder goes to the platform.
  - **Done when:** Unit tests cover even and uneven splits, such as 3 micro-USD, and no float ever touches an amount.
  - **Depends on:** P0-06

- [x] **P1-03 Ledger: post a Call and refund it** · `core` · M
  - **Goal:** In `lib/ledger`, write a Call's three entries in one transaction, write a refund as three reversing entries, add `balanceOf(account)`, and add a reserve-funds step that can't overdraw under concurrency (a row lock or serializable transaction).
  - **Done when:** Every F1 test passes, including the random run of 1,000 operations and the test of two concurrent Calls that would overdraw.
  - **Depends on:** P1-01, P1-02

- [x] **P1-04 Agent keys** · `core` · S
  - **Goal:** Generate `pk_agent_…` keys and store only a hash plus a prefix. Look up an agent from a key, support the optional `X-Piko-Secret`, and return 401 `invalid_key` for a bad key.
  - **Done when:** Tests cover a valid key, a revoked key and an unknown key.
  - **Depends on:** P1-01

- [x] **P1-05 `lib/llm` (Gemini with a Groq fallback)** · `ai` · S
  - **Goal:** One module that every AI feature uses: text, structured output and embeddings through the Vercel AI SDK. It switches to Groq on rate limits, and throws a typed `AiBusy` error that the UI can show.
  - **Done when:** A smoke test calls Gemini, and a forced failure falls back to Groq or throws `AiBusy`.
  - **Depends on:** P0-06, P0-05

- [x] **P1-06 Sample seller APIs** · `core` `ai` · M
  - **Goal:** Build the four APIs from [SEED_DATA.md §3](SEED_DATA.md#3-sellers-and-listings) under `/api/demo/sellers/*`:
    - Product Search: Channel3, falling back to a fixed product
    - Review Summariser: Gemini
    - Price History: a deterministic 90-day series per product id
    - Cheap Reviews
  - **Done when:** Each one answers directly over HTTP, and Price History returns the same series for the same id every time.
  - **Depends on:** P1-05

- [x] **P1-07 Minimal seed** · `core` · S
  - **Goal:** A repeatable `npm run seed` that creates Sam (agent and key), Priya Labs, DataCorp, the four listings and their endpoints, and Priya's $0.94 balance. The full demo world comes in P9-01.
  - **Done when:** Running the seed twice leaves the same state, and it prints Sam's key.
  - **Depends on:** P1-03, P1-04

- [x] **P1-08 Gateway: return a 402 challenge** · `core` · M
  - **Goal:** Add the route `/g/[seller]/[...path]`. It matches an endpoint, stores a Challenge (nonce, amount, `CHALLENGE_TTL_SECONDS`), and returns 402 with the challenge body and a base64 `PAYMENT-REQUIRED` header ([API.md](API.md)). It also applies the free allowance: the first N calls from a buyer skip the 402.
  - **Done when:** The F2 items for the challenge, its header and the free allowance pass.
  - **Depends on:** P1-07

- [x] **P1-09 `POST /api/pay` pipeline** · `core` · M
  - **Goal:** Check the key, then funds (§9 steps 1, 5 and 6), then issue the signed single-use Receipt JWT (`RECEIPT_TTL_SECONDS`) and reserve the amount. Build it as an ordered pipeline so Phase 5 can add the breaker, policy and budget steps. Return 410 `challenge_expired` and 402 `insufficient_funds`.
  - **Done when:** Tests cover a good payment, an expired challenge, a used challenge and an empty wallet.
  - **Depends on:** P1-08

- [x] **P1-10 Gateway: verify, forward and settle** · `core` · M
  - **Goal:** Read `PAYMENT-SIGNATURE`, verify the receipt (signature, binding, expiry, single use), forward the request upstream with a timeout of `UPSTREAM_TIMEOUT_MS`, write the `calls` row and the ledger entries, and return the `PAYMENT-RESPONSE` header.
  - **Done when:** The F2 items for a paid retry, a reused receipt and a tampered receipt pass.
  - **Depends on:** P1-09, P1-06

- [x] **P1-11 Facilitator endpoints** · `core` · S
  - **Goal:** Add `GET /api/facilitator/supported`, `POST /verify` and `POST /settle`, sharing the gateway's own verify and settle code.
  - **Done when:** The facilitator routes in openapi.yaml match the responses, and a test settles a Call through them.
  - **Depends on:** P1-10

- [x] **P1-12 `X-Piko-Autopay` shortcut** · `core` · S
  - **Goal:** With a key and `X-Piko-Autopay: true`, one request runs challenge → pay → forward on the server side.
  - **Done when:** The F2 autopay item passes, and the buyer is charged exactly once.
  - **Depends on:** P1-10

- [x] **P1-13 Demo agent script** · `core` · S
  - **Goal:** `scripts/agent.ts` runs the three-step loop against a running app with Sam's key and prints each step. It doubles as a test and as an example for the README.
  - **Done when:** It completes a paid call to Price History locally, and Sam's balance drops by $0.002.
  - **Depends on:** P1-10

---

## Phase 2: PayPal top-up and the Wallet
Covers TEST_PLAN **F4**.

- [ ] **P2-01 `lib/paypal` client** · `paypal` · S
  - **Goal:** A sandbox or live base URL from `PAYPAL_ENV`, a cached OAuth token, typed calls, a `PayPal-Request-Id` on every write, and readable errors.
  - **Done when:** A smoke test gets a sandbox token and creates and then voids an order.
  - **Depends on:** P0-02, P0-06

- [ ] **P2-02 Sessions and the persona switcher** · `core` `ui` · M
  - **Goal:** Sessions signed with `SESSION_SECRET`. A one-click persona login (Sam, Dana, Priya, Omar) when `DEMO_MODE=true`, and a simple email and password login otherwise. Pages are guarded by role.
  - **Done when:** Each persona lands on their own screen, and with `DEMO_MODE=false` the switcher is gone.
  - **Depends on:** P1-07

- [ ] **P2-03 App shell and landing page** · `ui` · M
  - **Goal:** The layout, navigation and Tailwind design tokens. The landing page has the pitch, *"I'm buying"* and *"I'm selling"*, and the persona switcher ([DESIGN.md §15](DESIGN.md#15-screens)).
  - **Done when:** It looks finished on desktop, works on a phone, and works in dark mode.
  - **Depends on:** P2-02

- [ ] **P2-04 Top-up orders: create and capture** · `paypal` `core` · M
  - **Goal:** A route that creates an Orders v2 order (intent CAPTURE) and a capture route that credits the wallet. Captures are idempotent on the capture id, and each top-up gets a `topups` row.
  - **Done when:** Capturing twice credits once, and the F4 idempotency item passes.
  - **Depends on:** P2-01, P1-03

- [ ] **P2-05 Webhook endpoint** · `paypal` `core` · M
  - **Goal:** `/api/paypal/webhook` verifies the signature with `PAYPAL_WEBHOOK_ID`, stores each event once in `webhook_events`, and sends it to a handler by type. This task covers `PAYMENT.CAPTURE.COMPLETED`; later phases register more handlers.
  - **Done when:** A replayed webhook credits nothing, and a bad signature gets a 400.
  - **Depends on:** P2-04, and the tunnel and webhook from [PAYPAL_SETUP.md](PAYPAL_SETUP.md) steps 4–5 (`human`, moved here from P0-02). Once the app runs locally, ask the human to do them and put the Webhook ID in `PAYPAL_WEBHOOK_ID`.

- [ ] **P2-06 Wallet screen** · `ui` `paypal` · L
  - **Goal:** The balance, a PayPal JS SDK v6 top-up button that explains a cancelled popup, the budget per task or day, the "notify above" setting, and keys (create, show once, revoke).
  - **Done when:** The F4 flow passes by hand in sandbox as Sam.
  - **Depends on:** P2-04, P2-03

- [ ] **P2-07 Live call feed** · `ui` `core` · M
  - **Goal:** A reusable component that streams new Calls by SSE, or by polling as a fallback. It's used on the Wallet, the Playground and the seller console.
  - **Done when:** A call from the demo agent script appears within 1 second.
  - **Depends on:** P2-06, P1-13

---

## Phase 3: Agent playground
Covers TEST_PLAN **F9**. This screen gets the most polish.

- [ ] **P3-01 Directory search API** · `ai` `core` · M
  - **Goal:** Store Gemini embeddings for each listing (pgvector, or in-app cosine similarity as a fallback) and add `GET /api/directory/search`.
  - **Done when:** The query "product prices" ranks Product Search and Price History first.
  - **Depends on:** P1-05, P1-07

- [ ] **P3-02 Agent tools** · `ai` `core` · M
  - **Goal:** Tools for the playground agent: search the directory, call a paid endpoint (through the real x402 loop with Sam's key), and check the budget left. Each tool result includes what it cost.
  - **Done when:** Calling the tools directly runs paid calls that show on the ledger.
  - **Depends on:** P3-01, P1-12

- [ ] **P3-03 Budget-aware agent loop** · `ai` · L
  - **Goal:** Gemini through the AI SDK with the tools, streaming its reasoning about cost. It weighs price against rating (it should pick Review Summariser over Cheap Reviews and say why), and stops near the task budget.
  - **Done when:** The monitor prompt finishes in under 30 s, with at least 3 paid calls and a total under $0.10.
  - **Depends on:** P3-02

- [ ] **P3-04 Playground screen** · `ui` · L
  - **Goal:** The chat, a reasoning panel, paid calls ticking by live (P2-07), and a budget meter.
  - **Done when:** The F9 UI items pass, and the screen looks polished enough to film.
  - **Depends on:** P3-03, P2-07

- [ ] **P3-05 Checkout at the end** · `paypal` `ai` `ui` · M
  - **Goal:** When the agent recommends a product, show a real Orders v2 checkout with `payee` set to `PAYPAL_DEMO_SHOP_EMAIL`, created through the PayPal Agent Toolkit.
  - **Done when:** `sam-buyer` pays in sandbox, and the order shows in `monitor-shop`.
  - **Depends on:** P3-04, P2-01

- [ ] **P3-06 Make the playground resilient** · `ai` · S
  - **Goal:** Cache recent runs, show an "AI busy" message on `AiBusy`, and never crash on a tool error.
  - **Done when:** The F9 item with Gemini rate-limited passes.
  - **Depends on:** P3-04

---

## Phase 4: Hosted gateway and the Directory screen
Covers part of TEST_PLAN **F10**.

- [x] **P4-01 Listing onboarding API** · `core` · M
  - **Goal:** Create a listing from a base URL: a slug, its endpoints and prices, and an embedding when it's published. Guard against SSRF by blocking private and loopback addresses, except the app's own `/api/demo` URLs.
  - **Done when:** A new listing's `/g/<slug>/…` URL returns 402, and a private IP is refused.
  - **Depends on:** P1-10, P3-01

- [x] **P4-02 Harden the gateway proxy** · `core` · S
  - **Goal:** Forward the method, query and body; strip Piko and hop-by-hop headers; add a body size limit; and give a clear error when upstream is unreachable.
  - **Done when:** Tests cover a GET with a query, a POST with JSON, and a body that's too large.
  - **Depends on:** P4-01

- [x] **P4-03 Directory screen** · `ui` · M
  - **Goal:** Search with cards showing name, description, price per call, rating, seller and HTTP or MCP badges. A card opens the listing's details and a copyable gateway URL.
  - **Done when:** The F9 directory item passes in the UI.
  - **Depends on:** P3-01, P2-03

- [x] **P4-04 "Connect an API" form** · `ui` · S
  - **Goal:** A seller pastes a URL, adds endpoints and prices, and publishes. Phase 6 builds the rest of the seller console.
  - **Done when:** The first F10 item passes as Priya.
  - **Depends on:** P4-01, P2-03

---

## Phase 5: Org controls
Covers TEST_PLAN **F5** and **F6**.

- [x] **P5-01 Org console shell** · `ui` · M
  - **Goal:** The team and agent tree for Acme, with each budget and spend so far. Create teams and agents, and move agents between teams.
  - **Done when:** Dana sees Acme's 3 teams and 5 agents (from a temporary seed until P9-01).
  - **Depends on:** P2-03

- [x] **P5-02 Budgets** · `core` · M
  - **Goal:** Budgets at the org, team, agent and task level, by day, month or task, with an optional category. Spend comes from the ledger. Add the budget step to the pay pipeline, returning 402 `budget_exceeded` with `remaining`.
  - **Done when:** The F5 agent-budget and team-budget items pass.
  - **Depends on:** P1-09

- [x] **P5-03 Policy schema and evaluator** · `core` · M
  - **Goal:** A zod schema for policies ([DESIGN.md §9](DESIGN.md#9-policy-engine-budgets-and-circuit-breaker)) and a deterministic evaluator in `lib/policy`: vendor block and allow, max price per call, and approval above an amount. A denial returns 403 `policy_denied` naming the policy. Checks run in the order §9 gives.
  - **Done when:** The F5 vendor-block item passes, and unit tests cover each rule type.
  - **Depends on:** P5-02

- [ ] **P5-04 Approvals** · `core` `ui` · M
  - **Goal:** An "approval above" rule creates an Approval and returns 202 `approval_pending`. `GET /api/approvals/{id}` lets the agent poll. The Org console gets an approvals inbox to approve or deny. An autopay 202 must also carry the Challenge `nonce`, since the agent never saw the 402 ([API.md §2](API.md#2-the-paid-call-flow-x402-v2) "Approvals"); test that an approved autopay request can be completed.
  - **Done when:** The F5 approval item passes for both approve and deny.
  - **Depends on:** P5-03, P5-01

- [x] **P5-05 Policy compiler** · `ai` `ui` · M
  - **Goal:** The admin types plain English. Gemini returns structured output, which is checked against the P5-03 schema and shown as a readable rule. Nothing is enforced until **Confirm** is clicked, and input that can't become a rule gets a clear message.
  - **Done when:** Both F5 compiler items pass.
  - **Depends on:** P5-03, P1-05

- [x] **P5-06 Circuit breaker** · `core` · M
  - **Goal:** `lib/breaker` keeps a sliding window per agent (`BREAKER_MAX_CALLS` per `BREAKER_WINDOW_SECONDS`) and a dollars-per-minute limit. Tripping it freezes the agent, writes an alert and returns 429 `breaker_tripped`. It's the second step in the pay pipeline.
  - **Done when:** The F6 breaker item passes with `loop-bot`.
  - **Depends on:** P1-09

- [x] **P5-07 Kill switch** · `core` `ui` · M
  - **Goal:** Freeze and unfreeze an agent, a team or a whole org. A frozen agent gets 423 `agent_frozen`, and so does a Receipt it already holds: the gateway's `PAYMENT-SIGNATURE` path must also refuse a frozen agent, team or org, so Receipts issued before a breaker trip or a freeze can't be redeemed after it. Add the controls to the Org console.
  - **Done when:** The F6 team-freeze and org-freeze items pass.
  - **Depends on:** P5-06, P5-01

- [x] **P5-08 Alerts** · `ui` · S
  - **Goal:** An alerts panel in the Org console for breaker trips, budget hits and denials, with a badge on the navigation.
  - **Done when:** A breaker trip shows as an alert within a few seconds.
  - **Depends on:** P5-06

- [x] **P5-09 Spend grid and audit export** · `ui` · M
  - **Goal:** An AG Grid of spend by team, agent, vendor and day, with grouping and CSV export. Simulated rows are labelled.
  - **Done when:** It handles 12,000 rows smoothly (seed a test set), and the CSV downloads.
  - **Depends on:** P5-01

---

## Phase 6: Seller console and Payouts
Covers TEST_PLAN **F7** and the rest of **F10**. With this phase done, the demo is complete.

- [x] **P6-01 Seller console** · `ui` · M
  - **Goal:** The listings, endpoints, prices and free allowances, editable, with the gateway URL and the earnings balance.
  - **Done when:** Priya can change a price, and the next challenge shows it.
  - **Depends on:** P4-04

- [ ] **P6-02 Seller analytics** · `ui` · M
  - **Goal:** Calls and revenue per endpoint, the top calling agents and orgs, and how many 402s turn into paid calls (AG Grid plus one chart).
  - **Done when:** The numbers match the ledger for the seeded data.
  - **Depends on:** P6-01

- [ ] **P6-03 Payouts** · `paypal` `core` · M
  - **Goal:** A Payouts batch with one item to the seller's PayPal email. A pending ledger debit is written when it's sent. It runs automatically when a settle pushes the balance to `PAYOUT_THRESHOLD_MICRO`, and also from a manual **Withdraw** button.
  - **Done when:** Priya going from $0.94 past $1.00 creates a sandbox payout on its own.
  - **Depends on:** P2-01, P6-01

- [ ] **P6-04 Payout webhooks** · `paypal` `core` · S
  - **Goal:** A succeeded event marks the payout settled. A failed, returned or blocked event reverses the debit. Both are idempotent.
  - **Done when:** Every F7 item passes in sandbox.
  - **Depends on:** P6-03, P2-05

- [ ] **P6-05 Live earnings** · `ui` · S
  - **Goal:** The seller console's earnings and the payout status update live (P2-07).
  - **Done when:** A demo call bumps Priya's earnings on screen within 1 second.
  - **Depends on:** P6-01, P2-07

---

## Phase 7: Org invoicing
Covers TEST_PLAN **F8**.

- [x] **P7-01 Work out the invoice** · `core` · S
  - **Goal:** From the ledger, an org's spend for a period, with one line per team.
  - **Done when:** The total equals the org's ledger debits for the period in tests.
  - **Depends on:** P5-02

- [ ] **P7-02 Create and send the invoice** · `paypal` · M
  - **Goal:** An Invoicing v2 create and send to the org's payer, with an `invoices` row and a "Generate this month's invoice now" button.
  - **Done when:** A sandbox invoice reaches `acme-payer` with the correct lines.
  - **Depends on:** P7-01, P2-01

- [ ] **P7-03 Invoice paid, and the credit limit** · `paypal` `core` · M
  - **Goal:** `INVOICING.INVOICE.PAID` marks the period settled. An org over its credit limit with an unpaid invoice has its keys paused (423).
  - **Done when:** Every F8 item passes.
  - **Depends on:** P7-02, P2-05

- [ ] **P7-04 Invoices in the Org console** · `ui` · S
  - **Goal:** A list of invoices with their status and a link to the PayPal invoice.
  - **Done when:** A paid invoice flips to "Paid" without a manual refresh.
  - **Depends on:** P7-03

---

## Phase 8: MCP, enterprise rates, refunds, pricing assistant
Covers TEST_PLAN **F3**, **F11**, and the rest of **F2** and **F10**.

- [x] **P8-01 Automatic refunds** · `core` · M
  - **Goal:** An upstream 5xx or timeout releases the Call's reservation without posting any ledger entries (in the `authorization` flow nothing is posted before the upstream answers), marks the Call refunded, and returns 502 `upstream_failed` with `refunded: true`. A 4xx stays paid.
  - **Done when:** Every F3 item passes.
  - **Depends on:** P1-10

- [ ] **P8-02 Enterprise rates** · `core` `ui` · S
  - **Goal:** A `rate_overrides` row changes the challenge price for that buyer org. The seller console gets a table to edit them.
  - **Done when:** The F2 enterprise-rate item passes: Acme sees $0.007 and Sam sees $0.010.
  - **Depends on:** P6-01

- [x] **P8-03 Paid MCP server** · `core` · L
  - **Goal:** `POST /mcp/{seller}` with the MCP TypeScript SDK. It lists a seller's endpoints as tools with prices in their descriptions, authenticates with an agent key, charges through the same pipeline, and returns `insufficient_funds` as a tool error.
  - **Done when:** Every F11 item passes in Claude Desktop or the MCP Inspector.
  - **Depends on:** P1-12

- [ ] **P8-04 AI pricing assistant** · `ai` `ui` · M
  - **Goal:** A seller pastes docs or an OpenAPI spec. Gemini suggests prices per endpoint and writes the listing copy. The seller edits it before publishing.
  - **Done when:** The F10 pricing item passes.
  - **Depends on:** P6-01, P1-05

---

## Phase 9: Polish and ship
Covers TEST_PLAN **F12**, **F13** and the [SUBMISSION.md](SUBMISSION.md) checklist.

- [x] **P9-01 Full demo seed** · `core` · L
  - **Goal:** All of [SEED_DATA.md](SEED_DATA.md): Acme's teams, agents and policies; about 12,000 simulated Calls from a fixed random seed; DataCorp at $12.40; Acme at $183 this month.
  - **Done when:** Running the seed twice gives identical dashboards, and every seeded Call has `simulated = true`.
  - **Left out on purpose:** (1) The "anything over 5 cents a call needs my OK" half of Acme's first policy: it is an `approval_above` rule, approvals (P5-04) aren't built, and on main a matching `approval_above` denies the Call. Only its $50/month search budget is seeded; add the rule when P5-04 lands. (2) Acme at **$183** this month: 12,000 Calls at these prices can't reach it, so Acme's month-to-date is whatever the history adds up to. (3) History covers the 29 UTC days before today, so timestamps are anchored to midnight and two runs on the same day are identical; a Call from "today" isn't seeded. (4) No `breaker` freeze is left in place (the demo trips it live): only the alert from 9 days ago. (5) Seller history already "paid out" is simulated: a `seed` Ledger entry pins Priya at $0.94 and DataCorp at $12.40, and no fake PayPal Payout row exists.
  - **Depends on:** Phases 1–7

- [x] **P9-02 Live simulated traffic** · `core` `ui` · S
  - **Goal:** `POST /api/demo/simulate` turns on 1–3 synthetic calls a second, with a start and stop toggle. Every simulated item in the UI carries a "simulated" label.
  - **Done when:** Every F12 item passes.
  - **Depends on:** P9-01

- [ ] **P9-03 UI polish pass** · `ui` · L
  - **Goal:** Empty, loading and error states on every screen, consistent spacing and type, phone widths, and dark mode. The Playground gets the most attention.
  - **Done when:** A screen-by-screen review finds nothing unfinished.
  - **Depends on:** Phases 2–8 (whatever was built)

- [ ] **P9-04 Deploy to Render** · `infra` `human` · M
  - **Goal:** Deploy the app as a Render web service, set its environment variables, run the migration and seed, and point the PayPal webhook at the Render URL. Setting the variables and the webhook is `human`.
  - **Done when:** F13 items 1 and 3 pass.
  - **Depends on:** P9-01

- [ ] **P9-05 Keep-awake ping** · `infra` · S
  - **Goal:** A GitHub Action that pings the Render URL every 10 minutes, running through Dec 15.
  - **Done when:** The Action's runs are green.
  - **Depends on:** P9-04

- [ ] **P9-06 Buyer SDK from APIMatic** · `docs` · S
  - **Goal:** Generate a TypeScript buyer SDK, plus one more language, from `openapi.yaml` and link it from the README.
  - **Done when:** The generated SDK makes one paid call against the hosted app.
  - **Depends on:** P9-04

- [ ] **P9-07 Postman collection** · `docs` · S
  - **Goal:** A public collection that calls the gateway, pay and the facilitator against the hosted app, with an environment for Sam's sandbox key.
  - **Done when:** "Run collection" passes, and it's linked from the README.
  - **Depends on:** P9-04

- [ ] **P9-08 Finish the README** · `docs` · S
  - **Goal:** Fill in every placeholder: the live URL, the sandbox logins, the run commands, screenshots and the video link.
  - **Done when:** No `<…>` placeholders are left.
  - **Depends on:** P9-04

- [ ] **P9-09 Run the whole test plan on the hosted app** · `human` · M
  - **Goal:** Run every flow from F1 to F13 against Render and fix what breaks (each fix is its own issue).
  - **Done when:** Every box in TEST_PLAN.md is ticked.
  - **Depends on:** P9-04 to P9-08

- [ ] **P9-10 Demo script and video** · `human` `docs` · L
  - **Goal:** Write DEMO_SCRIPT.md, then record a video under 3 minutes and upload it to YouTube as Public.
  - **Done when:** The video link works logged out.
  - **Depends on:** P9-09

- [ ] **P9-11 Make the repo public with an MIT licence** · `human` · S
  - **Goal:** Add the MIT `LICENSE`, show it in the repo's About section, check that no secrets are committed (F13), and make the repo public.
  - **Done when:** The repo section of SUBMISSION.md is ticked.
  - **Depends on:** P9-09

- [ ] **P9-12 Submit on Devpost** · `human` · S
  - **Goal:** Fill in the Devpost form from [SUBMISSION.md](SUBMISSION.md), aiming for the evening of Nov 11.
  - **Done when:** It shows as submitted, not a draft.
  - **Depends on:** P9-10, P9-11

---

## Stretch (only once Phase 9 is done)
- **S-01 Spend analyst:** a read-only "why did costs spike?" chat over spend data ([DESIGN.md §10](DESIGN.md#10-ai-features-gemini)).
- **S-02 Usage-based Billing:** replace our own invoice calculation if PayPal grants access (P0-04).
