import { z } from "zod";
import { getPrincipal } from "@/lib/auth";
import { CheckoutError, createCheckout } from "@/lib/checkout";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { parseUsd } from "@/lib/money";
import { getPayPal, PayPalError } from "@/lib/paypal";

const body = z.object({
  name: z.string().min(1).max(100),
  price: z.string().regex(/^\d{1,5}(\.\d{1,2})?$/),
});

/** Creates the end-of-demo checkout order, payable to the demo shop. */
export async function POST(request: Request) {
  if (!(await getPrincipal())) return jsonError(401, "unauthenticated", "Sign in first.");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, "invalid_request", 'Send { "name": "…", "price": "249.99" }.');
  }
  try {
    const { orderId } = await createCheckout(getPayPal(), {
      name: parsed.data.name,
      priceMicro: parseUsd(parsed.data.price),
      shopEmail: getEnv().PAYPAL_DEMO_SHOP_EMAIL,
    });
    return Response.json({ orderId });
  } catch (error) {
    if (error instanceof CheckoutError) return jsonError(400, error.code, error.message);
    if (error instanceof PayPalError) {
      return jsonError(502, "paypal_error", error.message, { debugId: error.debugId });
    }
    throw error;
  }
}
