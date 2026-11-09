/**
 * x402 v2 message shapes for the `paypal-ledger` scheme (docs/API.md section 2 and
 * docs/decisions/0011). Amounts are integer micro-USD, as strings.
 */
import { getEnv, type Env } from "../env";

export const X402_VERSION = 2;
export const PAYPAL_LEDGER_SCHEME = "paypal-ledger";
export const ASSET = "USD";
/** `extra.decimals`: an `amount` is in micro-USD. */
export const ASSET_DECIMALS = 6;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    decimals: number;
    nonce: string;
    expiresAt: string;
    facilitator: string;
    payUrl: string;
  };
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { receipt: string };
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
}

export interface X402Config {
  appBaseUrl: string;
  network: `paypal:${Env["PAYPAL_ENV"]}`;
  challengeTtlSeconds: number;
  receiptTtlSeconds: number;
  /** Signs Receipts (HS256). Never log it. */
  receiptSigningSecret: string;
}

export function x402ConfigFromEnv(env: Env = getEnv()): X402Config {
  return {
    appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ""),
    network: `paypal:${env.PAYPAL_ENV}`,
    challengeTtlSeconds: env.CHALLENGE_TTL_SECONDS,
    receiptTtlSeconds: env.RECEIPT_TTL_SECONDS,
    receiptSigningSecret: env.RECEIPT_SIGNING_SECRET,
  };
}

/** A priced gateway route, as a Challenge describes it. */
export interface ChallengeTerms {
  sellerSlug: string;
  path: string;
  listingName: string;
  listingDescription: string;
  nonce: string;
  amountMicro: bigint;
  expiresAt: Date;
}

export function buildResource(config: X402Config, terms: ChallengeTerms): ResourceInfo {
  return {
    url: `${config.appBaseUrl}/g/${terms.sellerSlug}${terms.path}`,
    description: terms.listingDescription,
    mimeType: "application/json",
    serviceName: terms.listingName,
  };
}

export function buildRequirements(config: X402Config, terms: ChallengeTerms): PaymentRequirements {
  return {
    scheme: PAYPAL_LEDGER_SCHEME,
    network: config.network,
    amount: terms.amountMicro.toString(),
    asset: ASSET,
    payTo: terms.sellerSlug,
    maxTimeoutSeconds: config.receiptTtlSeconds,
    extra: {
      decimals: ASSET_DECIMALS,
      nonce: terms.nonce,
      expiresAt: terms.expiresAt.toISOString(),
      facilitator: `${config.appBaseUrl}/api/facilitator`,
      payUrl: `${config.appBaseUrl}/api/pay`,
    },
  };
}

export function buildPaymentRequired(config: X402Config, terms: ChallengeTerms): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: `${PAYMENT_SIGNATURE_HEADER} header is required`,
    resource: buildResource(config, terms),
    accepts: [buildRequirements(config, terms)],
  };
}

/** Standard base64 of the UTF-8 JSON text, as all three x402 headers carry. */
export function encodeHeaderValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The inverse of {@link encodeHeaderValue}. Returns undefined if the value is not valid. */
export function decodeHeaderValue(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}
