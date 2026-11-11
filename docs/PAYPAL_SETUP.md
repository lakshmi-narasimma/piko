# Setup guide (humans only)

These steps need a person: accounts, logins and copying keys. Do them once, in order. Every value you collect goes into `.env.local` (and later into Render). The variable names come from [.env.example](../.env.example).

PayPal's dashboard layout changes from time to time. If a menu name below doesn't match, look for the closest equivalent and update this file.

---

## 1. PayPal developer account
1. Go to **developer.paypal.com** and log in with a normal PayPal account (or create a free one).
2. Make sure the dashboard toggle is set to **Sandbox**, not Live.

## 2. Sandbox test accounts
Open **Testing Tools → Sandbox Accounts** and create these six accounts. Give each a memorable email and note the generated password. Judges will use some of them.

| # | Type | Name it | Role in the demo |
|---|---|---|---|
| 1 | Business | `piko-platform` | Piko itself. It receives top-ups and sends payouts. **The REST app (step 3) belongs to this account.** |
| 2 | Business | `priya-seller` | Indie dev seller. Receives payouts. |
| 3 | Business | `datacorp-seller` | Organisation seller. Receives payouts. |
| 4 | Business | `monitor-shop` | Sells the monitor at the end of the demo. Its email goes in `PAYPAL_DEMO_SHOP_EMAIL`. |
| 5 | Personal | `sam-buyer` | Solo dev. Tops up a Piko wallet and buys the monitor. Give it a sandbox balance of **$500**. |
| 6 | Personal | `acme-payer` | Pays Acme's monthly invoice. Give it a balance of **$500**. |

Done when: all six appear in the list, and you've saved each email and password somewhere private (not in the repo).

## 3. REST app (API keys)
1. Open **Apps & Credentials** (Sandbox) → **Create App**.
2. Name it `piko`, type **Merchant**, and pick `piko-platform` as the sandbox business account.
3. Copy:
   - **Client ID** → `PAYPAL_CLIENT_ID` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`
   - **Secret** → `PAYPAL_CLIENT_SECRET`
4. In the app's feature settings, make sure these are **ticked**: Accept payments, **Payouts**, **Invoicing**, Vault (optional). Save.

Done when: the app shows Payouts and Invoicing as enabled.

## 4. Public URL for webhooks (local development)
PayPal needs a public HTTPS address to send webhooks to your laptop. Use a free tunnel. Either:
- `cloudflared tunnel --url http://localhost:3000`, or
- `ngrok http 3000`

Copy the `https://…` URL it prints into `APP_BASE_URL`. A free tunnel URL changes on every restart; when it does, update the webhook in step 5. Once deployed to Render, switch the webhook to the Render URL.

## 5. Webhook
1. In the `piko` app, open **Webhooks → Add Webhook**.
2. URL: `<APP_BASE_URL>/api/paypal/webhook`
3. Subscribe to these events:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.PAYOUTSBATCH.SUCCESS`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`
   - `PAYMENT.PAYOUTS-ITEM.FAILED`
   - `INVOICING.INVOICE.PAID`
   - `INVOICING.INVOICE.CANCELLED`
4. Save, then copy the **Webhook ID** → `PAYPAL_WEBHOOK_ID`.

Done when: the dashboard's webhook simulator can send a `PAYMENT.CAPTURE.COMPLETED` test event and the app logs it (once the app exists).

## 6. Gemini API key (free)
1. Go to **aistudio.google.com** → **Get API key** → create a key.
2. Copy it → `GEMINI_API_KEY`.
3. Check the current free-tier **Flash** model name and its rate limits, and put the model name in `GEMINI_MODEL`.

## 7. Channel3 API key (free: 1,000 calls/month)
1. Sign up at **trychannel3.com** and open the API keys page.
2. Copy the key → `CHANNEL3_API_KEY`.

## 8. Database (Neon, free)
1. Sign up at **neon.tech** and create a project called `piko`.
2. In **Connect**, copy both connection strings, each wrapped in double quotes (they contain `&`):
   - pooling **off** → `DATABASE_URL` (migrations)
   - pooling **on** (host ends in `-pooler`) → `DATABASE_URL_POOLED` (the app)
3. In the SQL editor, run `CREATE EXTENSION IF NOT EXISTS vector;`. If it fails, tell Claude, and directory search will fall back to in-app similarity.

## 9. Secrets you generate
Run `openssl rand -base64 32` twice:
- the first result → `SESSION_SECRET`
- the second → `RECEIPT_SIGNING_SECRET`

## 10. Ask on the PayPal Discord
In the hackathon Discord, ask: *"Can hackathon participants get sandbox access to the limited-release Usage-based Billing API?"* Record the answer in [DESIGN.md §19](DESIGN.md#19-open-items).

## 11. Later: deployment (Render)
Done once the app runs locally.
1. Push the repo to GitHub (public, MIT licence, see [SUBMISSION.md](SUBMISSION.md)).
2. On **render.com**, create a **Web Service** from the repo. Use the free instance type.
3. Add every variable from `.env.local` in Render's **Environment** tab. Set `APP_BASE_URL` to the Render URL.
4. Point the PayPal webhook (step 5) at `https://<render-url>/api/paypal/webhook`.
5. Claude adds the GitHub Action that pings the app every 10 minutes so it stays awake during judging (Dec 1–15).

---

## Checklist
- [x] 6 sandbox accounts created; logins saved privately
- [x] REST app created; Payouts and Invoicing enabled
- [ ] Webhook registered; `PAYPAL_WEBHOOK_ID` saved *(later: backlog task P2-05, once the app runs)*
- [x] Gemini key and model name saved
- [x] Channel3 key saved
- [x] Neon database created; `vector` extension enabled (or noted as failed)
- [x] Two secrets generated
- [ ] Discord question asked
