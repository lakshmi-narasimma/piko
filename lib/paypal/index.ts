/**
 * PayPal at the edges only: Orders for top-ups, Payouts for sellers, Invoicing for org
 * bills, and Webhooks. Every handler is idempotent on the PayPal resource id.
 */
export { getPayPal, PayPalClient, PayPalError, PAYPAL_BASE_URL } from "./client";
export {
  captureOrder,
  createOrder,
  fromPayPalValue,
  getOrder,
  toPayPalValue,
  type CreateOrderInput,
  type PayPalOrder,
} from "./orders";
export { verifyWebhookSignature } from "./verify";
