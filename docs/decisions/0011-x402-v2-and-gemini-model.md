# 0011. x402 v2 message shapes for `paypal-ledger`, and the Gemini models

**Status:** Accepted · 2026-11-05

## Context
[0002](0002-x402-style-protocol.md) chose x402's shape but left the exact v2 details and the custom-scheme rules open. [0003](0003-gemini-free-tier.md) chose the Gemini free tier but not a model. P0-05 checked both against primary sources. For x402 that was the x402-foundation `specs/` directory at commit `2884003` (2026-11-04). For Gemini it was Google's docs and live calls with the project's key on 2026-11-05.

**What x402 v2 actually says.** Our earlier drafts used several v1 shapes.
- **Headers (HTTP transport).** `PAYMENT-REQUIRED` (server → client) carries `PaymentRequired`, `PAYMENT-SIGNATURE` (client → server) carries `PaymentPayload`, and `PAYMENT-RESPONSE` (server → client) carries `SettlementResponse`. All three are **base64-encoded JSON**. The header is the canonical location, and the body is up to the server. The v1 names were `X-PAYMENT` / `X-PAYMENT-RESPONSE`.
- **`PaymentRequired`** is `{ x402Version: 2, error?, resource, accepts[], extensions? }`. `resource` is a **`ResourceInfo` object** (`url`, `description?`, `mimeType?`, `serviceName?`, `tags?`, `iconUrl?`) at the top level, not a string inside each `accepts[]` entry.
- **`PaymentRequirements`** (each `accepts[]` entry) is `{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra? }`. These fields are wrong in our drafts:
  - **`amount`** replaced v1's `maxAmountRequired`. It is a string in the asset's atomic units.
  - **`asset`** is a token address or an **ISO 4217 code for fiat**.
  - **`maxTimeoutSeconds`** is required.
  - **`extra`** is for scheme-specific data. It also has two reserved keys, `assetTransferMethod` and `paymentFlow`.
  - `description`, `nonce`, `expiresAt` and `facilitator` are not top-level fields.
- **`PaymentPayload`** is `{ x402Version, resource?, accepted, payload, extensions? }`. `accepted` echoes the chosen requirements, and `payload` is defined by the scheme.
- **`SettlementResponse`** is `{ success, errorReason?, errorMessage?, payer?, transaction, network, amount?, extensions? }`. `transaction` is required and is an empty string when nothing settled.
- **Facilitator:**
  - `POST /verify` and `POST /settle` take `{ x402Version, paymentPayload, paymentRequirements }`. `/verify` is read-only and returns `{ isValid, invalidReason?, invalidMessage?, payer? }`. `/settle` returns a `SettlementResponse`.
  - `GET /supported` returns `{ kinds: [{ x402Version, scheme, network, extra? }], extensions: [], signers: {} }`.
  - Clients and resource servers MUST match on the error code fields, never on message text.
- **Payment flows:** `authorization` is the default (verify → resource → settle). `upfront` and `escrow` also exist. If `extra.paymentFlow` is omitted, the flow is `authorization`.
- **Networks** use CAIP-2 `namespace:reference`, and "non-blockchain networks are encouraged to follow the CAIP-2 format (e.g. `ach:us`, `sepa:eu`)". The TypeScript SDK types a network as `` `${string}:${string}` ``.
- **Custom schemes:**
  - There is **no registry** and nothing to register. `scheme` and `network` are free strings, and clients skip `accepts[]` entries they don't recognise.
  - The spec already contains a non-crypto, credit-backed binding: `batch-settlement` on `cloudflare:402`, with `asset: "USD"` and `payTo: "merchant"`, in which the network bills the payer off-chain.
  - Two open proposals, [#2126](https://github.com/x402-foundation/x402/issues/2126) (`credit-bundle`) and [#2134](https://github.com/x402-foundation/x402/issues/2134), propose further fiat schemes.
  - The process for an *official* scheme (specs/CONTRIBUTING.md) has three steps: open an issue or discussion, write `specs/schemes/<name>/scheme_<name>.md` from `scheme_template.md`, then open a PR.
- **MCP transport:**
  - An unpaid call returns a tool result with `isError: true` and the `PaymentRequired` object in `structuredContent`, with the same JSON as text in `content[0].text`.
  - The client sends the payment in `_meta["x402/payment"]`.
  - The settlement comes back in `_meta["x402/payment-response"]`.
  - These are plain objects, not base64.

**What Gemini looks like today.** The live tests ran on 2026-11-05 against `v1beta` `generateContent`, each with one function declaration and one `responseSchema`.

| Model id | Status in docs | Tools + JSON test | Notes |
|---|---|---|---|
| `gemini-3.6-flash` | Stable, free tier | 200 both, ~1.5–3.7 s, 3 runs | Chosen primary |
| `gemini-3-flash-preview` | Preview, free tier | 200 both, ~1.4–2.3 s, 2 runs | Previews can be shut down at short notice |
| `gemini-3.5-flash-lite` (= `gemini-flash-lite-latest` today) | Stable, free tier | 200 both, but 6–17 s | Larger daily quota (see below) |
| `gemini-flash-latest`, `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.1-flash-lite` | Listed | 503 "high demand" on every try | Not usable today |
| `gemini-3.5-flash` | Listed | 200, but served as `modelVersion: gemini-3.6-flash` | Already rerouted |
| `gemini-2.5-flash` | Deprecated | 404 "no longer available to new users" | — |

- **Embeddings.** Both `gemini-embedding-001` and `gemini-embedding-2` return 3072 dimensions by default and 768 when `outputDimensionality: 768` is set. The docs recommend 768, 1536 or 3072.
  - `gemini-embedding-2` auto-normalises truncated vectors and takes up to 8,192 input tokens. It does not accept `task_type`; use a text prefix such as `task: search result | query: …` instead.
  - `gemini-embedding-001` must be normalised by hand below 3072 dimensions and takes up to 2,048 tokens.
  - Both are free on the Standard tier.
- **Free-tier rate limits.** Google no longer prints the free-tier numbers in its docs. The rate-limits page says they "can be viewed in Google AI Studio" (behind sign-in). It does confirm these points:
  - Limits apply per project (not per key) and per model.
  - RPD resets at midnight Pacific time.
  - Preview models are more restricted.
  - Third-party tables (not confirmed by Google) list:

    | Model | RPM | Input TPM | RPD |
    |---|---|---|---|
    | 3.6 / 3.8 Flash | 5 | 250K | 20 |
    | 3.5 / 3.1 Flash-Lite | 10 | 250K | 500 |
- **Vercel AI SDK.** `@ai-sdk/google` (4.0.111 on npm today, with `ai` 7.0.162) lists `gemini-3.6-flash`, `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-embedding-001` and `gemini-embedding-2`. It accepts any model id string.
  - Gemini 3 models support tool usage and structured output (`generateText` with `output: Output.object(...)`).
  - Embedding options go in `providerOptions.google.{ outputDimensionality, taskType }`.
  - Gemini 3 thought signatures must be passed back unchanged across turns. The SDK does this when the full message history is reused.

## Decision
**x402.** Piko speaks x402 v2 exactly, and adds only what the spec leaves to the scheme:
- `PAYMENT-REQUIRED` carries a `PaymentRequired` with a `ResourceInfo` object. Each `accepts[]` entry is `scheme: "paypal-ledger"`, `network: "paypal:sandbox"`, `amount` in micro-USD, `asset: "USD"`, `payTo: <seller slug>` and `maxTimeoutSeconds: RECEIPT_TTL_SECONDS`.
- Piko's own fields go in `extra: { decimals: 6, nonce, expiresAt, facilitator, payUrl }`.
- `PAYMENT-SIGNATURE` is a base64 `PaymentPayload` with `payload: { receipt: <JWT> }`. `POST /api/pay` also returns this ready-made as `paymentSignature`.
- `PAYMENT-RESPONSE` is a base64 `SettlementResponse` with `transaction` = Call id and `payer` = agent id.
- The facilitator routes use the spec's request and response bodies.
- The flow is the default `authorization` one. An external seller calls `/settle` only after its handler succeeds; an unsettled receipt simply expires and releases its reservation. The old `upstreamStatus` field on `/settle` is dropped.
- We do not register anything. A `scheme_paypal_ledger.md` upstream PR is an optional stretch for after the build.

**Gemini.**
- **Text, tools and structured output:** primary `GEMINI_MODEL=gemini-3.6-flash`.
- **Fallbacks:** `lib/llm` moves on after a 503 or 429, in the order `GEMINI_FALLBACK_MODELS=gemini-3-flash-preview,gemini-3.5-flash-lite`, then Groq.
- **Embeddings:** `GEMINI_EMBEDDING_MODEL=gemini-embedding-2` at `GEMINI_EMBEDDING_DIMENSIONS=768`, so a pgvector `vector(768)` column fits.
- **No aliases:** use pinned ids, never `-latest` aliases, because aliases hot-swap without notice and `gemini-flash-latest` was down today.

## Consequences
- API.md §2–§3, openapi.yaml (`Challenge`, `PaymentRequirement`, new `ResourceInfo` and `PaymentPayload`, `FacilitatorRequest`, `Settlement`, `Receipt.paymentSignature`) and DESIGN.md §8 now use the v2 shapes. Code in `lib/x402` must build and parse these exact objects. An x402 v2 client that understands only `exact` will see our 402 and skip it, which is the expected behaviour.
- Agents need two steps to build `PAYMENT-SIGNATURE` (call `/api/pay`, then send `paymentSignature`). The autopay shortcut still hides this.
- Gemini quotas are the main judging-day risk. If the ~20 RPD figure for Flash is right, a single playground run of 5–10 model calls uses half a day's quota. Mitigations:
  - Spread calls across the per-model fallback chain, since each model has its own quota.
  - Cache playground runs.
  - Keep Groq as the last fallback.
  - **A human must read the real free-tier numbers for this project at <https://aistudio.google.com/rate-limit> before P1-05 (the `lib/llm` module) is finished.**
- Model availability changes often (2.5 Flash was retired for new users; 3.5 Flash already routes to 3.6). Recheck the ids before demo day; changing them needs only env vars.
- Changing the embedding model or dimensions means re-embedding every listing, because vectors from different models are not comparable.

## Sources
- x402 v2 core spec: <https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md>
- x402 v2 HTTP transport: <https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md>
- x402 v2 MCP transport: <https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md>
- Spec contributing guide and scheme template: <https://github.com/x402-foundation/x402/blob/main/specs/CONTRIBUTING.md>, <https://github.com/x402-foundation/x402/blob/main/specs/scheme_template.md>
- Fiat, credit-backed precedent: <https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_cloudflare.md>
- Fiat scheme proposals: <https://github.com/x402-foundation/x402/issues/2126>, <https://github.com/x402-foundation/x402/issues/2134>
- SDK network type: <https://github.com/x402-foundation/x402/blob/main/typescript/packages/core/src/types/index.ts>
- Gemini models: <https://ai.google.dev/gemini-api/docs/models> (now redirects to aistudio.google.com/docs/models)
- Gemini rate limits: <https://ai.google.dev/gemini-api/docs/rate-limits> (now redirects to aistudio.google.com/docs/rate-limits)
- Gemini pricing (free-tier availability per model): <https://aistudio.google.com/docs/pricing>
- Gemini embeddings: <https://aistudio.google.com/docs/embeddings>
- Third-party free-tier table (unconfirmed by Google): <https://www.scriptbyai.com/gemini-api-free-tier-limits/>
- Vercel AI SDK Google provider: <https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai>
