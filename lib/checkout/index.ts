/**
 * The end-of-demo purchase: the product the agent recommended, paid for in real PayPal
 * sandbox checkout with the demo shop as payee. This is a plain Orders v2 order. It does not
 * touch the Wallet or the Ledger: the money goes from the buyer's PayPal account to the shop.
 */
import type { MicroUsd } from "../money";
import { captureOrder, createOrder, getOrder, type PayPalClient } from "../paypal";

export const MIN_CHECKOUT_MICRO = 1_000_000n;
export const MAX_CHECKOUT_MICRO = 2_000_000_000n;
const DESCRIPTION_PREFIX = "Piko demo checkout: ";

export class CheckoutError extends Error {
  constructor(
    public readonly code: "invalid_amount" | "not_a_checkout_order",
    message: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/**
 * Creates the order, payable to `shopEmail`. Returns PayPal's order id. `name` and
 * `priceMicro` must come from a server-side record (a verified checkout token), never from the
 * browser. `requestId` is sent as PayPal-Request-Id, so the same id always gets the same order.
 */
export async function createCheckout(
  paypal: PayPalClient,
  input: { name: string; priceMicro: MicroUsd; shopEmail: string; requestId?: string },
): Promise<{ orderId: string }> {
  const { name, priceMicro, shopEmail } = input;
  if (priceMicro < MIN_CHECKOUT_MICRO || priceMicro > MAX_CHECKOUT_MICRO) {
    throw new CheckoutError("invalid_amount", "That price is outside what the demo shop sells.");
  }
  if (priceMicro % 10_000n !== 0n) {
    throw new CheckoutError("invalid_amount", "Price must be in whole cents.");
  }
  const order = await createOrder(paypal, {
    amountMicro: priceMicro,
    requestId: `checkout-${input.requestId ?? crypto.randomUUID()}`,
    description: `${DESCRIPTION_PREFIX}${name}`.slice(0, 127),
    payeeEmail: shopEmail,
  });
  return { orderId: order.id };
}

/**
 * Captures an approved checkout order. It first checks that the order is one of ours (made
 * for the demo shop), so this route can't be used to capture some other order.
 */
export async function captureCheckout(
  paypal: PayPalClient,
  input: { orderId: string; shopEmail: string },
) {
  const order = (await getOrder(paypal, input.orderId)) as Awaited<ReturnType<typeof getOrder>> & {
    purchase_units?: Array<{ description?: string; payee?: { email_address?: string } }>;
  };
  const unit = order.purchase_units?.[0];
  const ours =
    unit?.payee?.email_address?.toLowerCase() === input.shopEmail.toLowerCase() &&
    unit.description?.startsWith(DESCRIPTION_PREFIX);
  if (!ours) {
    throw new CheckoutError("not_a_checkout_order", "That isn't a demo checkout order.");
  }
  const captured = await captureOrder(paypal, input.orderId);
  const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: captured.status, captureId: capture?.id ?? null };
}
