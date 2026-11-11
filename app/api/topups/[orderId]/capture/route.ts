import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { getPayPal, PayPalError } from "@/lib/paypal";
import { captureTopup, TopupError } from "@/lib/topups";

/** Captures an approved top-up order and credits the Wallet. Safe to repeat: it credits once. */
export async function POST(_: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const principal = await getPrincipal();
  if (!principal) return jsonError(401, "unauthenticated", "Sign in first.");
  if (principal.role !== "admin") return jsonError(403, "forbidden", "Only an admin can top up.");

  const { orderId } = await params;
  try {
    const result = await captureTopup(getDb(), getPayPal(), { orgId: principal.org.id, orderId });
    return Response.json({
      credited: result.credited,
      pending: result.pending,
      amountMicro: result.amountMicro.toString(),
      balanceMicro: result.balanceMicro.toString(),
    });
  } catch (error) {
    if (error instanceof TopupError) {
      const status = error.code === "topup_not_found" ? 404 : 409;
      return jsonError(status, error.code, error.message);
    }
    if (error instanceof PayPalError) {
      return jsonError(502, "paypal_error", error.message, { debugId: error.debugId });
    }
    throw error;
  }
}
