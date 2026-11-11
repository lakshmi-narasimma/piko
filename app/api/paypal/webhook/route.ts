import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { getPayPal, verifyWebhookSignature } from "@/lib/paypal";
import { WEBHOOK_HANDLERS } from "@/lib/webhooks/handlers";
import { isPayPalEvent, processWebhookEvent } from "@/lib/webhooks";

/** PayPal events. Signature-checked, stored once, and idempotent on the resource id. */
export async function POST(request: Request) {
  const { PAYPAL_WEBHOOK_ID } = getEnv();
  if (!PAYPAL_WEBHOOK_ID) {
    return jsonError(503, "webhook_not_configured", "PAYPAL_WEBHOOK_ID is not set.");
  }

  const event: unknown = await request.json().catch(() => null);
  if (!isPayPalEvent(event)) return jsonError(400, "invalid_event", "Not a PayPal event.");

  const genuine = await verifyWebhookSignature(getPayPal(), {
    headers: request.headers,
    event,
    webhookId: PAYPAL_WEBHOOK_ID,
  });
  if (!genuine) return jsonError(400, "invalid_signature", "The webhook signature is not valid.");

  const outcome = await processWebhookEvent(getDb(), event, WEBHOOK_HANDLERS);
  return Response.json({ outcome });
}
