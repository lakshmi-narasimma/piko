import { z } from "zod";
import { getPrincipal } from "@/lib/auth";
import { CheckoutError, createCheckout } from "@/lib/checkout";
import { verifyCheckoutToken } from "@/lib/checkout/token";
import { getEnv } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { getPayPal, PayPalError } from "@/lib/paypal";

const body = z.object({ token: z.string().min(1).max(4096) });

const REFUSED = {
  invalid: ["invalid_checkout_token", "That checkout link isn't valid. Run the agent again."],
  wrong_org: ["invalid_checkout_token", "That checkout link isn't valid. Run the agent again."],
  expired: ["checkout_token_expired", "That recommendation has expired. Run the agent again."],
} as const;

/**
 * Creates the end-of-demo checkout order, payable to the demo shop. The browser sends only the
 * checkout token from the playground run's `done` event; the product and its price come from
 * the signed token, never from the request.
 */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, "invalid_request", 'Send { "token": "…" } from the agent\'s run.');
  }
  const env = getEnv();
  const verified = verifyCheckoutToken(parsed.data.token, env.SESSION_SECRET, principal.org.id);
  if (!verified.ok) {
    const [code, message] = REFUSED[verified.reason];
    return jsonError(400, code, message);
  }
  const { claims } = verified;
  try {
    const { orderId } = await createCheckout(getPayPal(), {
      name: claims.name,
      priceMicro: claims.priceMicro,
      shopEmail: env.PAYPAL_DEMO_SHOP_EMAIL,
      // One token, one order: PayPal returns the same order if this token is sent again.
      requestId: claims.jti,
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
