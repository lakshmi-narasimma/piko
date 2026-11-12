# Piko

**Piko makes PayPal the default way AI agents pay, and get paid.**

- **Live demo:** https://piko-pay.onrender.com (open `/login` and pick a persona; the free instance can take about a minute to wake)
- **Demo video:** https://youtu.be/LYvDuZjMHow

Piko has two sides on one ledger:

- **Wallet (buyers):** an agent gets a Key, a PayPal-funded balance and Budgets. Solo developers use the Wallet; companies use the Org console.
- **Gateway (sellers):** any HTTP API or MCP tool can be listed with a per-call price. Calls are paid from the buyer's balance and credited to the seller's earnings.

Per-call amounts are fractions of a cent, smaller than PayPal's per-transaction fee. So Piko keeps an exact, append-only **ledger** (integer micro-USD) in the middle, and uses PayPal at the edges.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). All payments use the **PayPal sandbox**: no real money moves.

## How a paid call works

Piko follows the x402 v2 flow (HTTP 402, pay, retry with a receipt) with a `paypal-ledger` payment scheme. Piko is its own facilitator.

```
1. Agent  GET /g/priya/history                         (no payment header)
   Piko   402 + PAYMENT-REQUIRED  (price, payTo, nonce, payUrl)
2. Agent  POST /api/pay  {nonce}   Authorization: Bearer <Key>
   Piko   checks Budgets, Policies and the circuit breaker, reserves funds, returns a Receipt
3. Agent  GET /g/priya/history     PAYMENT-SIGNATURE: <Receipt>
   Piko   verifies, forwards to the seller API, writes 3 ledger entries (buyer, seller, platform)
   Agent  200 + the seller's response
```

If the seller's API fails (5xx or timeout), the Call is refunded automatically. Agents can skip the three steps with the `X-Piko-Autopay: true` shortcut (see below). Details: [docs/API.md](docs/API.md), [openapi.yaml](openapi.yaml), [docs/DESIGN.md](docs/DESIGN.md).

## What is built

| Area                 | Built on main                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger and money     | Append-only ledger in integer micro-USD, a Call's three entries in one transaction, refunds as reversing entries                                                                               |
| Gateway and x402     | `/g/{seller}/...` proxy, 402 challenges, `POST /api/pay`, signed Receipts, facilitator endpoints (`/api/facilitator/supported`, `verify`, `settle`), free allowances, size limits, SSRF guard, automatic refunds on upstream failure |
| Agent Keys           | Create, hash-store and revoke Keys; `X-Piko-Autopay` shortcut                                                                                                                                  |
| MCP server           | Paid MCP server at `/mcp/{seller}` (Streamable HTTP, Key in `Authorization: Bearer`)                                                                                                           |
| Sample seller APIs   | Product Search, Review Summariser, Price History and Cheap Reviews under `/api/demo/sellers/*`, behind the gateway                                                                             |
| Sign-in              | Persona switcher (when `DEMO_MODE=true`) and email and password login                                                                                                                          |
| Wallet               | PayPal top-up (Orders v2 and the JS SDK), balance, agents, budgets and Keys, live call feed                                                                                                    |
| Playground           | Budget-aware shopping agent (Gemini, Groq fallback) that searches the Directory and pays for Calls through the real gateway, then a PayPal checkout of the product it picks                    |
| Directory            | Embedding search over listings, listing detail pages with copyable gateway URLs                                                                                                                |
| Seller console       | Earnings balance, Listings, editable prices and free allowances, "Connect an API" form                                                                                                         |
| Org console          | Teams, agents, org and team Budgets, alerts panel and badge, kill switch (freeze an agent, team or whole org), spend grid with CSV export                                                                                                                                    |
| Policies and breaker | Deterministic policy schema and evaluator inside the pay pipeline; circuit breaker that freezes a runaway agent and raises an alert                                                            |
| Invoice calculation  | Works out an org's monthly invoice from the ledger, one line per team (calculation only, see below)                                                                                            |
| PayPal webhook       | `POST /api/paypal/webhook`: signature verified, events stored once, idempotent on the PayPal resource id                                                                                       |

## What is NOT built

These are not on main, so do not expect them in the demo:

- **Seller payouts** (PayPal Payouts) and payout webhooks. Seller earnings accrue on the ledger but are not paid out to PayPal.
- **PayPal Invoicing:** invoices are calculated but not created, sent or marked paid in PayPal, and there is no credit-limit enforcement from paid invoices.
- **Approvals** for calls over a policy threshold, and the **plain-English policy compiler** (Gemini compiling text into a policy). Policies are evaluated, but there is no screen to write or confirm them.
- **Seller analytics** and the **live earnings** view.
- **AI pricing assistant** and **enterprise rates**.
- **Live simulated traffic** (a generator that keeps writing simulated Calls while you watch). `npm run seed` loads the full demo world, including about 12,000 historical Calls labelled "simulated".
- The webhook handler only acts on `PAYMENT.CAPTURE.COMPLETED` (top-ups). Other event types are stored and ignored.

## How PayPal is used

- **Orders v2 and the JS SDK:** Wallet top-ups, and the end-of-demo product checkout in the playground (create an order, then capture it).
- **Webhooks:** `PAYMENT.CAPTURE.COMPLETED` credits the Wallet. Handlers are idempotent on the PayPal resource id.
- Per-call money never touches PayPal; it lives on the ledger.
- Payouts and Invoicing are part of the design but **not built** (see above). The PayPal Agent Toolkit is **not** used in this codebase.

## Stack

One Next.js (App Router, TypeScript) app, Postgres with pgvector (Neon in production), Drizzle ORM, Gemini through the Vercel AI SDK behind `lib/llm` (Groq as optional fallback), the MCP TypeScript SDK, Tailwind. Hosted on Render.

## Demo personas

Sign in at `/login`. With `DEMO_MODE=true`, pick a persona (no password):

| Persona                | Area           | What to try                                                                                          |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| **Sam** (solo dev)     | Wallet         | Top up with the PayPal sandbox, copy the agent Key, run the playground (find a monitor, then checkout) |
| **Dana** (Acme admin)  | Org console    | Teams, agents, Budgets and alerts                                                                    |
| **Priya** (Priya Labs) | Seller console | Listings, prices, free allowances, "Connect an API"                                                  |
| **Omar** (DataCorp)    | Seller console | Listings for Product Search and Cheap Reviews                                                        |

All four are created by `npm run seed`. Sandbox PayPal buyer logins for the top-up popup are in the Devpost submission; test credentials are not stored in this repo.

## Run it locally

Requirements: Node 24 or newer (`.node-version`), npm, Postgres with the pgvector extension, a PayPal developer sandbox app ([docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md)), a Gemini API key.

1. Start Postgres with pgvector. The tests use a separate database, so create two (one container can hold both):

   ```sh
   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=piko pgvector/pgvector:pg18
   docker exec <container> createdb -U postgres piko_test
   ```

2. `cp .env.example .env.local` and fill it in. Generate each of `SESSION_SECRET`, `RECEIPT_SIGNING_SECRET` and `DEMO_UPSTREAM_SECRET` with `openssl rand -base64 48` (at least 32 characters, each different). Locally `DATABASE_URL` and `DATABASE_URL_POOLED` can be the same URL. The app refuses to start if a required value is missing, and names it.
3. Install, migrate, seed and start:

   ```sh
   npm install
   npm run db:migrate   # apply migrations to DATABASE_URL
   npm run seed         # reset the database to the demo world (prints Sam's agent Key once)
   npm run dev          # http://localhost:3000
   ```

4. Tests need a separate Postgres with pgvector that `npm test` wipes and re-migrates on every run:

   ```sh
   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/piko_test npm test
   ```

   Without `TEST_DATABASE_URL` the database tests are skipped.

Checks (the same ones CI runs): `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

`npm run seed` wipes every table. Only point it at a demo database.

## Make a paid call from the command line

Put the Key that `npm run seed` printed in `PIKO_AGENT_KEY`. Fund Sam's wallet through the Wallet screen (PayPal top-up), or for local runs only seed it directly: `npm run seed -- --sam-wallet-micro=5000000` ($5.00).

The three-step loop, printed step by step (against a hosted app add `--base https://<your-app>`):

```sh
PIKO_AGENT_KEY=pk_agent_... npm run agent
```

The one-request shortcut: send the Key with `X-Piko-Autopay: true` and Piko runs the challenge, payment and retry internally:

```sh
curl -H "Authorization: Bearer $PIKO_AGENT_KEY" \
     -H "X-Piko-Autopay: true" \
     "http://localhost:3000/g/priya/history?product=demo-monitor"
```

Without the header the same URL returns the `402` challenge.

## MCP server

Every seller with MCP-enabled listings has a server at `/mcp/{seller}` (MCP Streamable HTTP, stateless). Authenticate with the agent Key as a Bearer token. Each paid endpoint is a tool, with its price in the description.

```sh
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP, URL: http://localhost:3000/mcp/priya
# header: Authorization: Bearer pk_agent_...
```

More clients (Claude Desktop, Cursor): [docs/API.md](docs/API.md) section 5.

## AI tools used

| Tool                                      | How it is used                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Gemini** (via the Vercel AI SDK) | The budget-aware shopping agent in the playground (tool calling), and embeddings for Directory search. Behind `lib/llm`, with pinned model ids. |
| **Groq** (via the Vercel AI SDK)          | Optional fallback for text and structured output when Gemini is rate-limited or unavailable.                                                    |
| **Claude Code**                           | Used for development of this project.                                                                                                           |

## Honesty notes

- All payments use the **PayPal sandbox**.
- Traffic created by the seed is flagged `calls.simulated` and labelled "simulated" in the UI. The minimal seed creates no simulated history.
- In production, holding prepaid balances would run on PayPal's multiparty setup with PayPal holding the funds.

## Docs

[docs/DESIGN.md](docs/DESIGN.md) (scope and concepts) · [docs/API.md](docs/API.md) · [openapi.yaml](openapi.yaml) · [docs/DEPLOY.md](docs/DEPLOY.md) · [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) · [docs/TEST_PLAN.md](docs/TEST_PLAN.md) · [docs/decisions/](docs/decisions/)

## License

MIT. See [LICENSE](LICENSE).
