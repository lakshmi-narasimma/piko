// `npm run paypal:smoke`: gets a sandbox token and creates a $0.01 order against the real
// PayPal sandbox, then reads it back. An unapproved CAPTURE order can't be voided (only
// authorisations can), so it is left to expire on its own after a few days.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { PayPalClient, PAYPAL_BASE_URL } from "../lib/paypal/client";
import { createOrder, getOrder } from "../lib/paypal/orders";

const { PAYPAL_ENV, PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (PAYPAL_ENV === "live") {
  console.error("paypal:smoke: refusing to run against live PayPal.");
  process.exit(1);
}
if (!clientId || !clientSecret) {
  console.error("paypal:smoke: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.");
  process.exit(1);
}

async function main(clientId: string, clientSecret: string) {
  const paypal = new PayPalClient({
    baseUrl: PAYPAL_BASE_URL.sandbox,
    clientId,
    clientSecret,
  });
  const order = await createOrder(paypal, {
    amountMicro: 10_000n,
    requestId: `smoke-${Date.now()}`,
    description: "Piko smoke test",
  });
  console.log(`created order ${order.id}: ${order.status}`);
  const read = await getOrder(paypal, order.id);
  console.log(`read it back: ${read.status}`);
  if (read.status !== "CREATED") process.exit(1);
  console.log("ok");
}

main(clientId, clientSecret).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
