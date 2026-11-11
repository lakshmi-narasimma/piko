import { completeTopup, TopupError } from "../topups";
import { fromPayPalValue } from "../paypal";
import type { WebhookHandler } from "./index";

interface CaptureResource {
  id: string;
  status?: string;
  amount?: { currency_code?: string; value?: string };
  supplementary_data?: { related_ids?: { order_id?: string } };
}

/**
 * PAYMENT.CAPTURE.COMPLETED: credits the Wallet if the capture belongs to a top-up. A
 * capture we didn't start (the end-of-demo checkout, for one) has no top-up and is ignored.
 */
export const onCaptureCompleted: WebhookHandler = async (db, event) => {
  const capture = event.resource as unknown as CaptureResource;
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  if (!orderId || !capture.amount?.value || capture.amount.currency_code !== "USD") return;

  try {
    await completeTopup(db, {
      orderId,
      captureId: capture.id,
      paidMicro: fromPayPalValue(capture.amount.value),
    });
  } catch (error) {
    if (error instanceof TopupError && error.code === "topup_not_found") return;
    throw error;
  }
};

export const WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {
  "PAYMENT.CAPTURE.COMPLETED": onCaptureCompleted,
};
