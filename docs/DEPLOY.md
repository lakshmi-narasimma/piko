# Deploy to Render

Piko is one Next.js web service on Render with a Postgres database on Neon. [render.yaml](../render.yaml) is a blueprint for the service; every secret in it is `sync: false`, so you enter the values in the Render dashboard. Never commit real values.

## Service settings

| Setting         | Value                                                                       |
| --------------- | --------------------------------------------------------------------------- |
| Runtime         | Node. Version 24 or newer (`NODE_VERSION=24`; the repo also has `.node-version`) |
| Build command   | `npm ci --include=dev && npm run build`                                     |
| Start command   | `npm start`                                                                 |
| Instance        | The free tier works. It sleeps when idle and takes up to about a minute to wake |

`--include=dev` matters: the build needs the dev dependencies (Tailwind, TypeScript), and Render sets `NODE_ENV=production`, which would otherwise skip them.

The server validates its environment at boot (`instrumentation.ts`) and exits non-zero naming each bad variable if one is missing or invalid, so a bad deploy fails instead of going live.

## Neon database

1. Create a Neon project and database (any Postgres 15 or newer with pgvector; the first migration runs `CREATE EXTENSION vector`).
2. Copy two connection strings from the Neon dashboard:
   - **Direct** connection (host without `-pooler`) goes in `DATABASE_URL`. `npm run db:migrate` and `npm run seed` use it.
   - **Pooled** connection (host ends in `-pooler`) goes in `DATABASE_URL_POOLED`. The running app uses it.
3. Both are normally `postgresql://user:password@host/dbname?sslmode=require`.

## Environment variables

Required (the app will not start without them). Placeholders only here; real values go in Render's settings.

| Variable                       | Where the value comes from                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `APP_BASE_URL`                 | The Render service URL, `https://<service>.onrender.com` (no trailing slash needed). Used in 402 challenges, MCP URLs and the seed |
| `SESSION_SECRET`               | `openssl rand -base64 48`. At least 32 characters                                                                                  |
| `RECEIPT_SIGNING_SECRET`       | `openssl rand -base64 48`. At least 32 characters, different from the others                                                       |
| `DEMO_UPSTREAM_SECRET`         | `openssl rand -base64 48`. At least 32 characters. The gateway sends it to the sample seller APIs as `X-Piko-Secret`               |
| `DATABASE_URL`                 | Neon direct connection string                                                                                                      |
| `DATABASE_URL_POOLED`          | Neon pooled connection string                                                                                                      |
| `PAYPAL_CLIENT_ID`             | PayPal developer dashboard, sandbox app ([PAYPAL_SETUP.md](PAYPAL_SETUP.md))                                                       |
| `PAYPAL_CLIENT_SECRET`         | Same sandbox app                                                                                                                   |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Same value as `PAYPAL_CLIENT_ID`. **Must be set before the build**: `next build` inlines it into the browser bundle               |
| `PAYPAL_DEMO_SHOP_EMAIL`       | Email of the sandbox business account that sells the demo product (the Orders payee)                                               |
| `GEMINI_API_KEY`               | Google AI Studio                                                                                                                   |

Needed for the full demo although the app boots without them:

| Variable            | Notes                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEMO_MODE`         | `true` shows the persona switcher. Default is `false`                                                         |
| `PAYPAL_WEBHOOK_ID` | From the webhook you register after the first deploy (below). Without it `/api/paypal/webhook` answers 503    |
| `PAYPAL_ENV`        | `sandbox` (the default). Keep it on sandbox                                                                   |

Optional (defaults are fine): `GROQ_API_KEY` (last-resort LLM fallback), `GROQ_MODEL`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_DIMENSIONS`, `CHANNEL3_API_KEY`, `PLATFORM_FEE_BPS`, `PAYOUT_THRESHOLD_MICRO`, `BREAKER_*`, `CHALLENGE_TTL_SECONDS`, `RECEIPT_TTL_SECONDS`, `UPSTREAM_TIMEOUT_MS`, `GATEWAY_MAX_BODY_BYTES`, `GATEWAY_MAX_RESPONSE_BYTES`. See [.env.example](../.env.example).

### Secret rules

- `SESSION_SECRET`, `RECEIPT_SIGNING_SECRET` and `DEMO_UPSTREAM_SECRET` must each be at least 32 characters and must not be `change-me`. Generate each with `openssl rand -base64 48`.
- Changing `RECEIPT_SIGNING_SECRET` invalidates Receipts that are already issued (they live 60 seconds). Changing `SESSION_SECRET` signs everyone out.
- Never paste real values into the repo, a PR or a screenshot.

## Order of steps

1. **Create the Neon database** and keep both connection strings.
2. **Create the Render web service** (from `render.yaml` as a Blueprint, or by hand with the settings above). Enter every variable. `APP_BASE_URL` is the URL Render shows for the service; if you do not know it yet, create the service first, copy the URL, then set it. `NEXT_PUBLIC_PAYPAL_CLIENT_ID` must be present before a build runs; if you add or change it later, trigger a rebuild.
3. **Deploy.** The first deploy may fail the boot check until all required variables are set; fix them and redeploy.
4. **Migrate and seed** from a machine with the repo checked out (or Render's shell), with `DATABASE_URL` pointing at Neon (direct) and **`APP_BASE_URL` set to the Render URL**. The seed stores `APP_BASE_URL` in each Listing's upstream URL, so seeding with `http://localhost:3000` would make the hosted gateway call localhost:

   ```sh
   DATABASE_URL="<neon direct url>" APP_BASE_URL="https://<service>.onrender.com" npm run db:migrate
   DATABASE_URL="<neon direct url>" APP_BASE_URL="https://<service>.onrender.com" npm run seed
   ```

   `npm run seed` wipes every table and prints Sam's agent Key once. Save it (it goes in `PIKO_AGENT_KEY` for the smoke test). Do not re-run it on a database you want to keep.

5. **Register the PayPal webhook** (below), put its id in `PAYPAL_WEBHOOK_ID` and redeploy.
6. **Smoke test** (below).

## PayPal webhook

1. In the PayPal developer dashboard, open the sandbox app, then **Webhooks, Add Webhook**.
2. URL: `<APP_BASE_URL>/api/paypal/webhook`, for example `https://<service>.onrender.com/api/paypal/webhook`.
3. Events: `PAYMENT.CAPTURE.COMPLETED` is the only event the code acts on (it credits the Wallet for a top-up). [PAYPAL_SETUP.md](PAYPAL_SETUP.md) lists the others the design will use later (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.DENIED`, payout and invoice events); subscribing to them is harmless, they are stored and ignored.
4. Save, copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` in Render, and redeploy. Signatures are verified with PayPal's verify-webhook-signature API using that id.
5. If the free tier was asleep, PayPal retries failed deliveries, and handlers are idempotent on the PayPal resource id.

## Smoke test

Run against the hosted URL in a private window.

- [ ] `/` loads and `/login` shows the persona cards (needs `DEMO_MODE=true`).
- [ ] Log in as **Sam**. The Wallet shows a $0.00 balance and the `shopping-assistant` agent.
- [ ] **Top up** with the sandbox buyer account in the PayPal popup. The balance rises after capture (and the webhook arrives).
- [ ] **Directory** lists the four sample APIs and search returns results (needs `GEMINI_API_KEY` for embeddings).
- [ ] **Playground** run: the agent searches, pays for Calls (they appear in the call feed) and offers the checkout.
- [ ] One paid call from outside the browser: `PIKO_AGENT_KEY=<Sam's key> npm run agent -- --base https://<service>.onrender.com`. It prints the 402, the payment and the paid retry.
- [ ] Log in as **Dana** (`/org`) and **Priya** (`/seller`): both consoles load.

## Known limits

- **Free tier sleep:** the first request after idle can take up to about a minute. There is no keep-awake ping in the repo.
- **Seller payouts and PayPal Invoicing are not built**, so the deployed demo cannot pay sellers out or invoice an org. See the README for the full list of what is not built.
- **Webhook acts on `PAYMENT.CAPTURE.COMPLETED` only.** Top-ups are also credited when the browser captures the order.
- **Seed resets the whole database.** There is no incremental seed.
- **Sandbox only.** `PAYPAL_ENV` should stay `sandbox`; no real money moves.
- **LLM free-tier limits:** Gemini can rate-limit; the app falls back to other pinned Gemini models and to Groq only when `GROQ_API_KEY` is set. Embeddings have no Groq fallback.
