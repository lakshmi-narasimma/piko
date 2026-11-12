import { getPrincipal } from "@/lib/auth";
import { captureCheckout, CheckoutError } from "@/lib/checkout";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { getPayPal, PayPalError } from "@/lib/paypal";

/** Captures the buyer's approved checkout order. */
export async function POST(_: Request, { params }: { params: Promise<{ orderId: string }> }) {
  if (!(await getPrincipal())) return jsonError(401, "unauthenticated", "Sign in first.");
  const { orderId } = await params;
  try {
    const result = await captureCheckout(getPayPal(), {
      orderId,
      shopEmail: getEnv().PAYPAL_DEMO_SHOP_EMAIL,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof CheckoutError) return jsonError(409, error.code, error.message);
    if (error instanceof PayPalError) {
      const status = error.status === 422 ? 409 : 502;
      return jsonError(status, "paypal_error", error.message, { debugId: error.debugId });
    }
    throw error;
  }
}
