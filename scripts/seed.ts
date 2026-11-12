// `npm run seed`: resets DATABASE_URL to the full demo world (lib/seed, docs/SEED_DATA.md). This
// wipes every table, so only point it at the demo database. Reads .env.local the same way
// Next.js does; a shell variable wins.
//
// `npm run seed -- --sam-wallet-micro=5000000` also funds Sam's wallet, so `npm run agent`
// can make a paid Call before PayPal top-ups exist.
// `npm run seed -- --calls=2000` sets how many simulated Calls of history to create
// (default 12,000; 0 for none).
// PRIYA_PAYPAL_EMAIL and DATACORP_PAYPAL_EMAIL, when set, become the sellers' payout emails.
import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createDb } from "../lib/db/client";
import { DEFAULT_HISTORY_CALLS, seed } from "../lib/seed";

loadEnvConfig(process.cwd());

const parsed = z
  .object({
    DATABASE_URL: z.url(),
    APP_BASE_URL: z.url(),
    PRIYA_PAYPAL_EMAIL: z
      .email()
      .optional()
      .or(z.literal("").transform(() => undefined)),
    DATACORP_PAYPAL_EMAIL: z
      .email()
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .safeParse(process.env);
if (!parsed.success) {
  console.error(
    "seed: DATABASE_URL or APP_BASE_URL is missing or not a URL, or a seller PayPal email is " +
      "not an email (see .env.example).",
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: { "sam-wallet-micro": { type: "string" }, calls: { type: "string" } },
});
const samWallet = z
  .string()
  .regex(/^\d+$/, "must be a whole number of micro-USD")
  .optional()
  .safeParse(values["sam-wallet-micro"]);
if (!samWallet.success) {
  console.error("seed: --sam-wallet-micro must be a whole number of micro-USD.");
  process.exit(1);
}
const samWalletMicro = samWallet.data === undefined ? undefined : BigInt(samWallet.data);

const callCount = z
  .string()
  .regex(/^\d{1,6}$/, "must be a whole number from 0 to 999999")
  .optional()
  .safeParse(values.calls);
if (!callCount.success) {
  console.error("seed: --calls must be a whole number of Calls, 0 to 999999.");
  process.exit(1);
}
const historyCalls = callCount.data === undefined ? DEFAULT_HISTORY_CALLS : Number(callCount.data);

const { DATABASE_URL, APP_BASE_URL, PRIYA_PAYPAL_EMAIL, DATACORP_PAYPAL_EMAIL } = parsed.data;
const db = createDb(DATABASE_URL, { max: 1 });

console.log(
  `seed: resetting ${new URL(DATABASE_URL).host} to the demo world (${historyCalls} simulated Calls) ...`,
);
const started = Date.now();
seed(db, {
  appBaseUrl: APP_BASE_URL,
  samWalletMicro,
  historyCalls,
  sellerPaypalEmails: { priya: PRIYA_PAYPAL_EMAIL, datacorp: DATACORP_PAYPAL_EMAIL },
})
  .then(({ samKey }) => {
    console.log(`seed: done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    console.log(`seed: Sam's agent key (shown once): ${samKey}`);
  })
  .catch((error: unknown) => {
    console.error("seed: failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$client.end());
