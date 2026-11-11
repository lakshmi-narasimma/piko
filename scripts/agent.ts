// `npm run agent`: runs the three-step x402 loop against a running Piko, printing each step.
//
//   1. GET the gateway URL with no payment header, and get a 402 Challenge.
//   2. POST the nonce to /api/pay with the agent's Key, and get a Receipt.
//   3. Retry the GET with PAYMENT-SIGNATURE, and get the upstream response.
//
// The Key comes from PIKO_AGENT_KEY (or --key); `npm run seed` prints Sam's. It is never
// printed. Reads .env.local the same way Next.js does; a shell variable wins.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { formatUsd } from "../lib/money";

export interface AgentOptions {
  baseUrl: string;
  key: string;
  seller: string;
  path: string;
  query: string;
  log?: (line: string) => void;
}

export interface AgentResult {
  status: number;
  body: string;
  nonce: string;
  amountMicro: string;
  callId: string;
}

function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/** Throws with the server's error code and message, so the failing step is obvious. */
async function failStep(step: string, response: Response): Promise<never> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error) detail = `${response.status} ${body.error.code}: ${body.error.message}`;
  } catch {
    // The body wasn't JSON; the status is all there is.
  }
  throw new Error(`${step} failed: ${detail}`);
}

/** Runs one paid Call through the three-step loop. Throws if any step fails. */
export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { baseUrl, key, seller, path, query, log = () => {} } = options;
  const target = `${baseUrl.replace(/\/+$/, "")}/g/${seller}${path}${query ? `?${query}` : ""}`;

  log(`1. GET ${target} (no payment header)`);
  const challengeResponse = await fetch(target);
  if (challengeResponse.status !== 402) await failStep("Challenge", challengeResponse);

  const challenge = decodeHeader(challengeResponse.headers.get("PAYMENT-REQUIRED")!) as {
    accepts: Array<{ amount: string; payTo: string; extra: { nonce: string; payUrl: string } }>;
  };
  const offer = challenge.accepts[0]!;
  log(`   402 Challenge: ${formatUsd(BigInt(offer.amount))} to ${offer.payTo}`);

  log(`2. POST ${offer.extra.payUrl} with the agent's Key`);
  const payResponse = await fetch(offer.extra.payUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ nonce: offer.extra.nonce }),
  });
  if (!payResponse.ok) await failStep("Payment", payResponse);
  const { paymentSignature, expiresAt } = (await payResponse.json()) as {
    paymentSignature: string;
    expiresAt: string;
  };
  log(`   200 Receipt issued, valid until ${expiresAt}`);

  log(`3. GET ${target} with PAYMENT-SIGNATURE`);
  const paidResponse = await fetch(target, {
    headers: { "PAYMENT-SIGNATURE": paymentSignature },
  });
  if (!paidResponse.ok) await failStep("Paid request", paidResponse);

  const settlement = decodeHeader(paidResponse.headers.get("PAYMENT-RESPONSE")!) as {
    transaction: string;
    amount: string;
    payer: string;
  };
  const body = await paidResponse.text();
  log(`   ${paidResponse.status} Upstream response: ${body}`);
  log(`   Paid ${formatUsd(BigInt(settlement.amount))}, Call ${settlement.transaction}`);

  return {
    status: paidResponse.status,
    body,
    nonce: offer.extra.nonce,
    amountMicro: settlement.amount,
    callId: settlement.transaction,
  };
}

async function main() {
  loadEnvConfig(process.cwd());

  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      key: { type: "string" },
      seller: { type: "string", default: "priya" },
      path: { type: "string", default: "/history" },
      query: { type: "string", default: "product=demo-monitor" },
    },
  });

  const key = values.key ?? process.env.PIKO_AGENT_KEY;
  if (!key) {
    console.error("agent: set PIKO_AGENT_KEY (npm run seed prints Sam's key) or pass --key <key>.");
    process.exit(1);
  }

  try {
    await runAgent({
      baseUrl: values.base ?? process.env.APP_BASE_URL ?? "http://localhost:3000",
      key,
      seller: values.seller!,
      path: values.path!,
      query: values.query!,
      log: console.log,
    });
  } catch (error) {
    console.error(`agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Runs only as a script, so tests can import runAgent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
