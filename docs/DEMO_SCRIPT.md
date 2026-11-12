# Demo script (under 3 minutes)

Record in a browser against the hosted app, signed out first. Keep the PayPal sandbox popup logins ready. Everything shown as history is labelled "simulated"; say so once, out loud.

Rehearse once with a stopwatch. If a step runs long, cut the **bold optional** lines first.

## 0:00 to 0:20. The problem
**Screen:** landing page.
**Say:** "AI agents can pay for APIs with Stripe or crypto. There is no PayPal option, and no way for a company to say how much an agent may spend. Piko is both halves: a wallet for buyers, a gateway for sellers, one ledger."

## 0:20 to 1:05. Sam: top up and let an agent shop
**Screen:** persona switcher, pick **Sam**, open the wallet.
1. Top up $5 with the PayPal sandbox popup. Balance updates.
2. Open the Playground, ask: "Find me a good monitor under $300." Show the agent's tool calls and the per-call costs ticking in.
**Say:** "Each call costs a fraction of a cent, below PayPal's per-transaction fee, so Piko keeps an exact ledger in the middle. PayPal moves the real money at the edges."
**Show:** the 402, pay, retry loop on one call (request, 402 with price, pay, receipt, data).

## 1:05 to 1:50. Dana: control before the money moves
**Screen:** switch to **Dana (Acme)**, open the Org console.
1. Spend grid: group by team, point at the "simulated" labels, download the CSV.
2. Alerts: show the circuit breaker alert for `loop-bot` (the deliberately buggy agent).
3. Kill switch: freeze a team, then show a frozen agent's call returns 423 `agent_frozen`. Unfreeze.
**Say:** "Budgets, policies, the breaker and the kill switch are plain code that runs before a call is paid. The AI never decides whether money moves."

## 1:50 to 2:30. Priya: get paid
**Screen:** switch to **Priya**, open the Seller console.
1. Show the earnings balance, change a price, show the next 402 carries the new price.
2. **Connect an API: paste a base URL, get a priced listing and a gateway URL.**
3. **If payouts are in: make a few calls so the balance passes $1.00 and show the sandbox PayPal payout.**
**Say:** "Any API or MCP tool becomes a paid one in minutes, priced per call."

## 2:30 to 2:55. Close
**Screen:** directory page, then the repo.
**Say:** "Piko makes PayPal the default way agents pay, and get paid. Open source, MIT, running on the PayPal sandbox."

## Before recording
- [ ] Seed has run on the hosted app (`npm run seed`), and Sam's wallet is at $0 for the top-up.
- [ ] `DEMO_MODE=true` so the persona switcher works.
- [ ] Browser zoom 110%, notifications off, no personal tabs visible.
- [ ] No copyrighted music. Upload to YouTube as **Public**, then check the link in a private window.
