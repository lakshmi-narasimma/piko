import { z } from "zod";
import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { parseUsd } from "@/lib/money";
import { getPayPal, PayPalError } from "@/lib/paypal";
import { createTopup, TopupError } from "@/lib/topups";

const body = z.object({ amount: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/) });

/** Creates a PayPal Order for a Wallet top-up. Body: `{ "amount": "5.00" }` in dollars. */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");
  if (principal.role !== "admin") return jsonError(403, "forbidden", "Only an admin can top up.");

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, "invalid_request", 'Send { "amount": "5.00" } in dollars.');
  }

  try {
    const { orderId, topupId } = await createTopup(getDb(), getPayPal(), {
      orgId: principal.org.id,
      amountMicro: parseUsd(parsed.data.amount),
    });
    return Response.json({ orderId, topupId });
  } catch (error) {
    if (error instanceof TopupError) return jsonError(400, error.code, error.message);
    if (error instanceof PayPalError) {
      return jsonError(502, "paypal_error", error.message, { debugId: error.debugId });
    }
    throw error;
  }
}
