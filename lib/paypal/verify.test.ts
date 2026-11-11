import { describe, expect, it, vi } from "vitest";
import type { PayPalClient } from "./client";
import { verifyWebhookSignature } from "./verify";

const headers = new Headers({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
  "paypal-transmission-id": "tid",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-11-12T00:00:00Z",
});

function fake(status: string) {
  const request = vi.fn(async () => ({ verification_status: status }));
  return { paypal: { request } as unknown as PayPalClient, request };
}

describe("verifyWebhookSignature", () => {
  it("sends PayPal the signature headers, the webhook id and the event", async () => {
    const { paypal, request } = fake("SUCCESS");
    const event = { id: "WH-1" };
    expect(await verifyWebhookSignature(paypal, { headers, event, webhookId: "HOOK" })).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      expect.objectContaining({
        body: expect.objectContaining({
          webhook_id: "HOOK",
          transmission_id: "tid",
          webhook_event: event,
        }),
      }),
    );
  });

  it("is false when PayPal says the signature failed", async () => {
    const { paypal } = fake("FAILURE");
    expect(await verifyWebhookSignature(paypal, { headers, event: {}, webhookId: "H" })).toBe(
      false,
    );
  });

  it("is false, without calling PayPal, when signature headers are missing", async () => {
    const { paypal, request } = fake("SUCCESS");
    const bare = new Headers({ "paypal-transmission-id": "tid" });
    expect(await verifyWebhookSignature(paypal, { headers: bare, event: {}, webhookId: "H" })).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
