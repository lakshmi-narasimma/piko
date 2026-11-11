import type { MicroUsd } from "../money";
import type { PayPalClient } from "./client";

const MICRO_PER_CENT = 10_000n;

/**
 * PayPal takes decimal dollars with two places. Only whole cents are representable, and
 * this is the one place a micro-USD amount becomes a string for PayPal.
 */
export function toPayPalValue(micro: MicroUsd): string {
  if (micro <= 0n || micro % MICRO_PER_CENT !== 0n) {
    throw new RangeError(`Cannot send ${micro} micro-USD to PayPal: use a whole number of cents.`);
  }
  const cents = micro / MICRO_PER_CENT;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** The inverse of toPayPalValue, for amounts PayPal reports back. */
export function fromPayPalValue(value: string): MicroUsd {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new RangeError(`Not a USD amount: ${value}`);
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents * MICRO_PER_CENT;
}

export interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount: { currency_code: string; value: string };
      }>;
    };
  }>;
}

export interface CreateOrderInput {
  amountMicro: MicroUsd;
  /** A stable id (such as our own row's) so a retried create returns the same order. */
  requestId: string;
  description?: string;
  /** Sell on behalf of another merchant, for the end-of-demo checkout. */
  payeeEmail?: string;
}

export function createOrder(paypal: PayPalClient, input: CreateOrderInput): Promise<PayPalOrder> {
  return paypal.request<PayPalOrder>("POST", "/v2/checkout/orders", {
    requestId: input.requestId,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: input.description,
          amount: { currency_code: "USD", value: toPayPalValue(input.amountMicro) },
          ...(input.payeeEmail ? { payee: { email_address: input.payeeEmail } } : {}),
        },
      ],
    },
  });
}

export function getOrder(paypal: PayPalClient, orderId: string): Promise<PayPalOrder> {
  return paypal.request<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/** The order id doubles as the request id, so capturing twice can't charge twice. */
export function captureOrder(paypal: PayPalClient, orderId: string): Promise<PayPalOrder> {
  return paypal.request<PayPalOrder>(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { requestId: `capture-${orderId}` },
  );
}
