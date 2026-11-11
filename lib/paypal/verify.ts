import type { PayPalClient } from "./client";

/** The headers PayPal signs every webhook delivery with. */
const SIGNATURE_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

/**
 * Asks PayPal whether a webhook delivery is genuine (its verify-webhook-signature API).
 * False for a bad signature and for missing signature headers; throws only when PayPal
 * itself can't be reached, so the caller can answer 5xx and let PayPal retry.
 */
export async function verifyWebhookSignature(
  paypal: PayPalClient,
  input: { headers: Headers; event: unknown; webhookId: string },
): Promise<boolean> {
  const { headers, event, webhookId } = input;
  const h = Object.fromEntries(
    Object.entries(SIGNATURE_HEADERS).map(([key, name]) => [key, headers.get(name)]),
  );
  if (Object.values(h).some((value) => !value)) return false;

  const result = await paypal.request<{ verification_status: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    {
      body: {
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      },
    },
  );
  return result.verification_status === "SUCCESS";
}
