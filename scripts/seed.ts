// `npm run seed`: resets DATABASE_URL to the minimal demo world (lib/seed). This wipes
// every table, so only point it at the demo database. Reads .env.local the same way
// Next.js does; a shell variable wins.
//
// `npm run seed -- --sam-wallet-micro=5000000` also funds Sam's wallet, so `npm run agent`
// can make a paid Call before PayPal top-ups exist.
import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createDb } from "../lib/db/client";
import { seed } from "../lib/seed";

loadEnvConfig(process.cwd());

const parsed = z.object({ DATABASE_URL: z.url(), APP_BASE_URL: z.url() }).safeParse(process.env);
if (!parsed.success) {
  console.error("seed: DATABASE_URL or APP_BASE_URL is missing or not a URL (see .env.example).");
  process.exit(1);
}

const { values } = parseArgs({ options: { "sam-wallet-micro": { type: "string" } } });
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

const { DATABASE_URL, APP_BASE_URL } = parsed.data;
const db = createDb(DATABASE_URL, { max: 1 });

console.log(`seed: resetting ${new URL(DATABASE_URL).host} to the minimal demo world ...`);
seed(db, { appBaseUrl: APP_BASE_URL, samWalletMicro })
  .then(({ samKey }) => {
    console.log("seed: done.");
    console.log(`seed: Sam's agent key (shown once): ${samKey}`);
  })
  .catch((error: unknown) => {
    console.error("seed: failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$client.end());
