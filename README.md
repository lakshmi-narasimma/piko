# Piko

**Piko makes PayPal the default way AI agents pay, and get paid.**

AI agents can already pay for APIs with Stripe or crypto. Piko brings them to PayPal:

- **For developers:** one PayPal-funded wallet and one key for every API and MCP tool your agent uses, with a hard budget.
- **For companies:** budgets per team and agent, plain-English spending policies, approvals, a kill switch and one monthly PayPal invoice, all enforced *before* the money moves.
- **For sellers:** turn any API or MCP tool into a paid one in minutes, priced per call, paid out to your PayPal.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

> 🚧 **Work in progress.** Links and setup steps below get filled in as the build lands.

---

## Try it
- **Live demo:** `<Render URL>`. The free hosting tier may take up to 60 seconds to wake up on the first visit.
- **Demo video:** `<YouTube link>`
- **No signup needed:** pick a persona on the landing page:

| Persona | What to try |
|---|---|
| **Sam** (solo dev) | Top up with PayPal, then ask the agent playground to find a monitor |
| **Dana** (Acme admin) | Write a spending policy in plain English, approve a request, freeze a runaway agent, generate the monthly invoice |
| **Priya** (indie seller) | Watch earnings arrive live and trigger a PayPal payout |

**PayPal sandbox logins** for the checkout popups (test accounts, no real money):

| Account | Email | Password |
|---|---|---|
| Sam (buyer) | `<sandbox email>` | `<sandbox password>` |
| Acme payer | `<sandbox email>` | `<sandbox password>` |

## How it works
```
Agent ──request──▶ Piko gateway ──402 "pay $0.002"──▶ Agent
Agent ──pay──▶ Piko (budgets · policies · circuit breaker) ──receipt──▶ Agent
Agent ──request + receipt──▶ Piko gateway ──▶ seller API ──data──▶ Agent
```
- Per-call amounts are fractions of a cent, smaller than PayPal's per-transaction fee, so Piko keeps an exact **ledger** in the middle.
- **PayPal moves the real money at the edges:**
  - top-ups through **Orders v2** and the **JS SDK**
  - company bills through **Invoicing**
  - seller earnings through **Payouts**
  - every event confirmed by **Webhooks**
- The protocol follows **x402** (HTTP 402 → pay → retry with a receipt), with a new `paypal-ledger` payment scheme. Piko acts as its facilitator.

More detail: [docs/DESIGN.md](docs/DESIGN.md) · API: [docs/API.md](docs/API.md) · [openapi.yaml](openapi.yaml)

## AI tools used
| Tool | How it's used |
|---|---|
| **Google Gemini** (free tier) | The budget-aware shopping agent in the playground. Turning plain-English policies into enforceable rules. Suggesting prices from a seller's API docs. Embeddings for directory search. |
| **PayPal Agent Toolkit** | Gives the playground agent PayPal actions (checkout, invoicing) |
| **Claude Code** (Anthropic) | Wrote the code, with the team directing the design |

## Sponsor tools
| Tool | Use |
|---|---|
| **Channel3** | Powers the sample Product Search API that agents pay to use |
| **AG Grid** | Call logs, spend breakdowns and seller analytics, plus CSV audit export |
| **APIMatic** | Generates the Piko buyer SDK from `openapi.yaml` |
| **Postman** | Public collection for calling the gateway and facilitator directly |
| **Render** | Hosting |

## Run it locally
1. Requirements: Node 24 LTS or newer (see `.node-version`), npm, a free Neon Postgres database, a PayPal developer account.
2. Follow [docs/PAYPAL_SETUP.md](docs/PAYPAL_SETUP.md) to create the sandbox accounts and keys.
3. `cp .env.example .env.local` and fill it in. The app refuses to start if a required value is missing, and names it.
4. Install, set up the database and start the app:
   ```sh
   npm install
   npm run db:migrate   # apply database migrations
   npm run seed         # load the demo data
   npm run dev          # http://localhost:3000
   ```
5. Open http://localhost:3000.

Checks (the same ones CI runs):
```sh
npm run lint        # ESLint + Prettier
npm run typecheck   # TypeScript, strict
npm test            # Vitest
npm run build       # production build
```

## Deploy (Render)
- Set every variable from `.env.example` in Render's environment settings. The server checks them at boot and exits non-zero if one is missing or invalid, so a bad deploy fails instead of going live.
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID` is inlined into the browser bundle by `next build`, so it must be set before the build runs, not only at runtime. Changing it needs a rebuild.

## Honesty notes
- All payments use the **PayPal sandbox**: no real money.
- Dashboard history and background traffic are **simulated** and labelled as such in the app. Every flow that moves money (top-ups, payouts, invoices, checkout) is real sandbox activity.
- In production, holding prepaid balances would run on PayPal's multiparty setup with PayPal holding the funds.

## License
MIT. See [LICENSE](LICENSE). *(Added when the repo goes public.)*
