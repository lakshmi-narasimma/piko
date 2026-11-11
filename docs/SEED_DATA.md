# Seed data

The demo world that `npm run seed` (or the equivalent script) creates. Seeding must be **repeatable**: running it twice resets the demo to this exact state. Real PayPal sandbox objects (orders, payouts, invoices) are never faked. Seeded history only lives on Piko's ledger and is marked `simulated = true`.

All amounts below are in dollars for readability. Store them as micro-USD.

## 1. Personas (persona switcher)

| Persona | Account | Org | Role | PayPal sandbox account |
|---|---|---|---|---|
| **Sam** | sam@demo.piko | "Sam (personal)", prepaid | admin | `sam-buyer` |
| **Dana, Acme admin** | dana@acme.demo | **Acme Corp**, invoiced | admin | `acme-payer` |
| **Priya** | priya@demo.piko | "Priya Labs", seller | admin | `priya-seller` |
| **Omar, DataCorp** | omar@datacorp.demo | **DataCorp**, seller | admin | `datacorp-seller` |

The emails are Piko logins, separate from the PayPal sandbox emails. The persona switcher logs in without a password when `DEMO_MODE=true`.

## 2. Buyers

### Sam (solo dev, prepaid)
- Wallet balance: **$0.00**. The demo starts with a real PayPal top-up of $5. For local runs before PayPal top-ups exist, `npm run seed -- --sam-wallet-micro=<micro-USD>` starts the wallet funded through a `seed` Ledger entry.
- Agent: `shopping-assistant`, with one key. Budget: **$1.00 per task**. "Notify above" threshold: **$0.05 per call**.

### Acme Corp (organisation, invoiced)
- Credit limit **$500**, monthly org budget **$300**.

| Team | Monthly budget | Agents |
|---|---|---|
| Marketing | $50 | `campaign-researcher`, `competitor-watch` |
| Support | $80 | `ticket-triage` |
| Data | $150 | `catalog-sync`, `loop-bot` (deliberately buggy: used to trip the circuit breaker) |

Policies (seeded as already compiled and confirmed, with their English source text):
1. *"Marketing agents can't spend more than $50 a month on search, and anything over 5 cents a call needs my OK."*
2. *"Nobody at Acme may use the 'Cheap Reviews' API."*

One blank policy box is left empty so the demo can compile a new one live.

## 3. Sellers and listings

| Listing | Seller | Kind | Endpoint | Price | Free allowance | Backing |
|---|---|---|---|---|---|---|
| **Product Search** | DataCorp | http + mcp | `GET /search?q=` | $0.010 | 5 per buyer | **Channel3** API (real) |
| **Review Summariser** | Priya Labs | http + mcp | `POST /summarise` | $0.005 | 0 | Gemini (real) |
| **Price History** | Priya Labs | http + mcp | `GET /history?product=` | $0.002 | 0 | Synthetic 90-day series (deterministic per product id) |
| **Cheap Reviews** | DataCorp | http | `POST /summarise` | $0.003 | 0 | Same as Review Summariser, but rated **2.1★**. It exists so the agent can choose against it. |

**Enterprise rate:** Acme pays **$0.007** for Product Search (everyone else pays $0.010).

**Ratings:** Product Search 4.7★, Review Summariser 4.6★, Price History 4.8★, Cheap Reviews 2.1★.

The sample seller APIs run inside the app under `/api/demo/sellers/*`. Their listings point to those URLs as the upstream base URL, so the hosted gateway proxies to them like any external API.

## 4. Seller balances
- Priya Labs: **$0.94**. The first few live demo calls push it past the **$1.00** payout threshold, so a real PayPal Payout fires on camera.
- DataCorp: **$12.40**, from simulated history.

## 5. Simulated history (last 30 days)
Generated deterministically from a fixed random seed, all `simulated = true`:
- About **12,000 calls** across Acme's agents and ~20 synthetic external buyer orgs.
- Weekday peaks, quieter weekends. Marketing spends mostly on Product Search; Data spends mostly on Price History.
- About 1% of calls refunded (upstream 5xx).
- A handful of `policy_denied` and `budget_exceeded` events, and one breaker trip 9 days ago.
- Acme's current month: **$183** spent so far, so the invoice demo has real line items.

## 6. Live simulated traffic (demo mode)
`POST /api/demo/simulate` starts a background generator: 1–3 calls per second from synthetic buyers, so the dashboards move during the video. Same `simulated = true` flag. It's off by default.

## 7. Demo product (end of the playground flow)
- The agent recommends a **27-inch 4K monitor at $289** found through Product Search. The live Channel3 result decides the exact item. If Channel3 returns nothing, fall back to a fixed seeded product.
- Checkout: a real Orders v2 order with `payee` = `PAYPAL_DEMO_SHOP_EMAIL`, paid by `sam-buyer`.
