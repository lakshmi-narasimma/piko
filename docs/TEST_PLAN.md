# Test plan

The flows that must never break. Each one has automated tests (unit or integration against a test database) **and** a manual check against the real PayPal sandbox. A feature counts as finished when its flow passes both ways. Before recording the video and before submitting, run the whole plan.

Tag key: **[auto]** automated test · **[sandbox]** manual check against real PayPal sandbox · **[ui]** look at it in the browser.

---

## F1. Ledger correctness [auto]
- [ ] A paid $0.002 Call writes exactly three entries: buyer −2000, seller +1900, platform +100. They sum to zero.
- [ ] Fee rounding: a price that doesn't divide evenly (e.g. 3 micro-USD) gives the seller the rounded-down share and the platform the remainder. The entries still sum to zero.
- [ ] A refund writes three reversing entries, and balances return to their values before the Call.
- [ ] Balance = the sum of entries, for every wallet and seller, after a random sequence of 1,000 Calls and refunds.
- [ ] Two concurrent Calls that would overdraw a $0.003 balance: exactly one succeeds.

## F2. Paid-call loop (x402) [auto + ui]
- [ ] A gateway request with no payment header → 402 with a valid challenge, plus the base64 `PAYMENT-REQUIRED` header.
- [ ] `POST /api/pay` with the nonce → receipt. Retry with `PAYMENT-SIGNATURE` → 200 with the upstream body and a `PAYMENT-RESPONSE` header.
- [ ] Reusing the same receipt → rejected (single-use).
- [ ] An expired challenge (past `CHALLENGE_TTL_SECONDS`) → 410 `challenge_expired`.
- [ ] A tampered receipt (changed amount) → rejected.
- [ ] `X-Piko-Autopay: true` with a key → one request returns the upstream body and charges once.
- [ ] Free allowance: the first 5 Product Search calls from a new buyer get no 402. The 6th does.
- [ ] Enterprise rate: Acme sees $0.007 in the challenge, Sam sees $0.010.

## F3. Refund on upstream failure [auto]
- [ ] Upstream returns 500 → the agent gets 502 `upstream_failed` with `refunded: true`, and the wallet is unchanged.
- [ ] Upstream hangs past `UPSTREAM_TIMEOUT_MS` → same as above.
- [ ] Upstream returns 404 → the Call stays **paid** (only 5xx and timeouts refund).

## F4. Top-up through PayPal [sandbox + ui]
- [ ] As Sam, top up $5 → PayPal sandbox popup → log in as `sam-buyer` → approve → the wallet shows $5.00 within 5 s.
- [ ] Refreshing or double-clicking capture doesn't credit twice (idempotent on capture id).
- [ ] A replayed `PAYMENT.CAPTURE.COMPLETED` webhook doesn't credit twice.
- [ ] A cancelled popup credits nothing and shows a clear message.

## F5. Budgets, policies, approvals [auto + ui]
- [ ] Agent budget: Sam's $1.00 task budget blocks the next Call with 402 `budget_exceeded`, and `remaining` is correct.
- [ ] Team budget: Marketing at its $50 cap blocks `campaign-researcher` even though Acme's org budget has room.
- [ ] Vendor block: any Acme agent calling Cheap Reviews → 403 `policy_denied`, naming the policy.
- [ ] Approval: a Marketing call over $0.05 → 202 `approval_pending`. Approving it in the Org console lets the agent's poll return a receipt. Denying it returns `denied`.
- [ ] Policy compiler: typing *"Support agents can spend at most $10 a day"* produces a valid budget rule scoped to Support. It isn't enforced until **Confirm** is clicked.
- [ ] Policy compiler, bad input (*"make it cheaper somehow"*): returns a clear "couldn't turn this into a rule" message and saves nothing.

## F6. Circuit breaker and kill switch [auto + ui]
- [ ] `loop-bot` making more than 50 calls in 10 s → 429 `breaker_tripped`, the agent is frozen, and an alert appears in the Org console.
- [ ] A frozen agent's next call → 423 `agent_frozen`.
- [ ] Freezing the Marketing team blocks both Marketing agents. Unfreezing restores them.
- [ ] Org-wide freeze blocks every Acme agent but no other org's agents.

## F7. Seller payout [sandbox + ui]
- [ ] Priya at $0.94 + live demo calls → passes $1.00 → a Payout is created automatically → status pending → webhook → **settled**. The money shows in the `priya-seller` sandbox account.
- [ ] Manual **Withdraw** for DataCorp sends the full balance.
- [ ] A failed payout (e.g. an invalid receiver in a test) reverses the seller debit, and the balance is restored.
- [ ] A replayed payout webhook doesn't double-settle.

## F8. Org invoice [sandbox + ui]
- [ ] "Generate invoice now" for Acme → a PayPal sandbox invoice with one line per team. The total equals Acme's ledger spend for the period.
- [ ] Paying it as `acme-payer` → `INVOICING.INVOICE.PAID` → the period shows settled in the Org console.
- [ ] Acme over its credit limit with an unpaid invoice → its keys are paused (423).

## F9. Directory and agent playground [ui]
- [ ] Directory search "product prices" returns Product Search and Price History first.
- [ ] The playground prompt *"Find me the best 4K monitor under $300 that's actually in stock"* completes in under 30 s. It shows the reasoning, at least 3 paid calls ticking live, and a total under $0.10.
- [ ] The agent picks Review Summariser over Cheap Reviews and says why.
- [ ] The final **Buy** opens real PayPal checkout, paid by `sam-buyer`, with `monitor-shop` as payee.
- [ ] Gemini rate-limited or unavailable → the "AI busy" fallback message, no crash.

## F10. Hosted gateway onboarding [ui]
- [ ] As Priya, paste a base URL and get a `/g/<slug>/…` URL. A test call through it returns 402.
- [ ] The pricing assistant suggests prices per endpoint from pasted docs, and the seller can edit them before publishing.

## F11. MCP server [manual]
- [ ] Add `/mcp/priya` to Claude Desktop (or the MCP Inspector) with Sam's key. The tools are listed with prices in their descriptions.
- [ ] Calling Price History returns data plus "Charged $0.002 via Piko", and Sam's wallet drops by $0.002.
- [ ] With Sam's wallet empty, the tool call returns an `insufficient_funds` tool error.

## F12. Dashboards and honesty [ui]
- [ ] AG Grid views load 12,000 seeded Calls without freezing. Grouping by team and agent works, and CSV export downloads.
- [ ] Every simulated Call and chart is labelled **simulated**. Live demo calls are not.
- [ ] The live call feed updates within 1 s of a Call.

## F13. Deployment [manual, before submitting]
- [ ] The Render URL loads in a private window in under 60 s, even from cold.
- [ ] The keep-awake GitHub Action has run successfully in the last hour.
- [ ] F4, F7 and F8 pass against the **hosted** app, with the webhook pointed at Render.
- [ ] No secret appears in the repo (`git grep` for the client secret, API keys and the signing secret returns nothing).
