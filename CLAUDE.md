# Piko

Piko makes PayPal the default way AI agents pay, and get paid. It has two sides on one ledger: a **Wallet** for buyers (solo devs and orgs with budgets, policies and a kill switch) and a **Gateway** for sellers (any API or MCP tool, priced per call, paid out to PayPal). Built for the PayPal AI Hackathon. Submission deadline: Nov 12, 2026, 12:00pm PST.

## Read before working
- **Picking up a GitHub issue**: find its ID (e.g. `P1-03`) in [docs/BACKLOG.md](docs/BACKLOG.md). Follow "How we work" there: one issue, one branch named after the ID, one PR with `Closes #N`. Tick the task when it merges.
- **Any feature work**: [docs/DESIGN.md](docs/DESIGN.md) is the source of truth for scope, concepts, money flows and build order. Use its glossary terms (Wallet, Agent, Key, Policy, Budget, Challenge, Receipt, Call, Ledger entry, Payout) in code and UI.
- **Touching an HTTP route, the x402 flow or the MCP server**: [docs/API.md](docs/API.md) and [openapi.yaml](openapi.yaml). Change the spec in the same commit as the code.
- **Reopening a settled choice**: [docs/decisions/](docs/decisions/) holds the reasons. To change a decision, add a new record that supersedes the old one.
- **Creating demo data**: [docs/SEED_DATA.md](docs/SEED_DATA.md).
- **Finishing a feature**: run the matching flow in [docs/TEST_PLAN.md](docs/TEST_PLAN.md) and keep it green.
- **PayPal credentials, sandbox accounts or webhooks**: [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md). Those steps are done by a human; ask rather than guess values.

## Stack
One Next.js (App Router, TypeScript) app on Render, Postgres on Neon, Gemini through the Vercel AI SDK behind `lib/llm`, the PayPal Agent Toolkit plus REST, the MCP TypeScript SDK, AG Grid Community, Tailwind.

## Money rules (hard guardrails)
- Store and compute every amount as **integer micro-USD** (`bigint`, 1 USD = 1,000,000). Convert to dollars only when displaying.
- The ledger is **append-only**: a balance is the sum of its `ledger_entries`. Write each Call's three entries (buyer, seller, platform) in one transaction. A refund is three reversing entries.
- Make every PayPal webhook handler and capture handler **idempotent** on the PayPal resource id.
- Per-call money lives only on the ledger. PayPal is called only at the edges: top-ups (Orders), seller payouts (Payouts), org bills (Invoicing), and the end-of-demo product checkout.
- Enforcement (budgets, policies, circuit breaker, kill switch) is deterministic code in `lib/policy` and `lib/breaker`. Gemini only *compiles* plain English into a policy that an admin confirms.

## Secrets
Read every secret from environment variables listed in [.env.example](.env.example). Add new ones there with a placeholder value in the same change. Real values live in `.env.local` (git-ignored) and in Render's settings.

## Demo honesty
Seeded traffic sets `calls.simulated = true` and the UI labels it "simulated". Every flow that moves money uses the real PayPal sandbox.

## Build order
Follow DESIGN.md §17. Finish and test a step before starting the next, so a time cut drops whole features, never half of one.
