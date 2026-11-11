/**
 * The `POST /api/pay` pipeline (docs/DESIGN.md section 9): an ordered list of steps, each of
 * which can stop the payment by throwing a PayError. Phase 5 inserts the breaker, policy
 * and budget steps into PAY_STEPS, between the Challenge lookup and the funds check.
 */
import { eq, sql } from "drizzle-orm";
import {
  breakerLimitsFromEnv,
  BreakerTrippedError,
  checkBreaker,
  confirmBreaker,
  type BreakerLimits,
} from "../breaker";
import type { Db } from "../db/client";
import { challenges, endpoints, listings, orgs } from "../db/schema";
import { jsonError } from "../http";
import { authenticateRequest, type AuthenticatedAgent } from "../keys";
import {
  InsufficientFundsError,
  LedgerError,
  reserveFunds,
  type LedgerErrorCode,
  type Reservation,
} from "../ledger";
import {
  buildRequirements,
  buildResource,
  encodeHeaderValue,
  X402_VERSION,
  type ChallengeTerms,
  type PaymentPayload,
  type X402Config,
} from "../x402";
import { signReceipt } from "../x402/receipt";

/** Stops a payment. Maps to the API's error body (docs/API.md section 4). */
export class PayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PayError";
  }
}

export interface PayDeps {
  db: Db;
  config: X402Config;
  /** The circuit breaker's limits. Read from the environment when left out. */
  breaker?: BreakerLimits;
}

export interface IssuedReceipt {
  receipt: string;
  paymentSignature: string;
  amount: string;
  expiresAt: string;
}

export interface PayableChallenge extends ChallengeTerms {
  buyerOrgId: string | null;
  agentId: string | null;
  endpointId: string;
  sellerOrgId: string;
  consumedAt: Date | null;
  reservationActive: boolean;
}

interface PayContext extends PayDeps {
  headers: Headers;
  body: unknown;
  agent?: AuthenticatedAgent;
  nonce?: string;
  challenge?: PayableChallenge;
  reservation?: Reservation;
  issued?: IssuedReceipt;
}

export interface PayStep {
  name: string;
  run: (context: PayContext) => Promise<void>;
}

/** The API's response for a Ledger failure while reserving. Anything else is a bug. */
const LEDGER_ERRORS: Partial<Record<LedgerErrorCode, [number, string, string]>> = {
  challenge_not_found: [404, "not_found", "No Challenge has this nonce."],
  challenge_expired: [410, "challenge_expired", "This Challenge has expired."],
  challenge_consumed: [410, "challenge_expired", "This Challenge has already been used."],
  challenge_already_reserved: [410, "challenge_expired", "This Challenge has already been used."],
  challenge_buyer_mismatch: [
    403,
    "challenge_buyer_mismatch",
    "This Challenge was issued to a different buyer.",
  ],
  // The gateway never issues a $0 Challenge, so this only guards against bad data.
  invalid_amount: [400, "invalid_amount", "This Challenge has no amount to pay."],
};

function asPayError(error: unknown): unknown {
  if (error instanceof BreakerTrippedError) {
    return new PayError(429, "breaker_tripped", error.message, error.details);
  }
  if (error instanceof InsufficientFundsError) {
    return new PayError(402, "insufficient_funds", "Prepaid balance or credit limit is too low.", {
      balance: error.availableMicro.toString(),
    });
  }
  if (error instanceof LedgerError) {
    const mapped = LEDGER_ERRORS[error.code];
    if (mapped) return new PayError(...mapped);
  }
  return error;
}

/** Reads a Challenge with what paying and verifying it need. Takes no locks. */
export async function loadChallenge(db: Db, nonce: string): Promise<PayableChallenge | undefined> {
  const [row] = await db
    .select({
      nonce: challenges.nonce,
      amountMicro: challenges.amountMicro,
      expiresAt: challenges.expiresAt,
      buyerOrgId: challenges.buyerOrgId,
      agentId: challenges.agentId,
      endpointId: challenges.endpointId,
      sellerOrgId: listings.sellerOrgId,
      consumedAt: challenges.consumedAt,
      reservationActive: sql<boolean>`coalesce(${challenges.reservedAt} is not null and ${challenges.reservationExpiresAt} > clock_timestamp(), false)`,
      sellerSlug: orgs.slug,
      path: endpoints.pathOrTool,
      listingName: listings.name,
      listingDescription: listings.description,
    })
    .from(challenges)
    .innerJoin(endpoints, eq(challenges.endpointId, endpoints.id))
    .innerJoin(listings, eq(endpoints.listingId, listings.id))
    .innerJoin(orgs, eq(listings.sellerOrgId, orgs.id))
    .where(eq(challenges.nonce, nonce));
  return row;
}

const authenticateAgent: PayStep = {
  name: "key",
  async run(context) {
    if (context.agent) return; // The caller authenticated it already (the gateway's autopay).
    const auth = await authenticateRequest(context.db, context.headers);
    if (!auth.ok) throw new PayError(401, "invalid_key", "Missing, wrong or revoked key.");
    context.agent = auth;
  },
};

const rejectFrozen: PayStep = {
  name: "frozen",
  async run({ agent }) {
    if (agent!.frozenScope) {
      throw new PayError(
        423,
        "agent_frozen",
        `This agent is frozen at ${agent!.frozenScope} level.`,
        {
          scope: agent!.frozenScope,
        },
      );
    }
  },
};

const loadPayableChallenge: PayStep = {
  name: "challenge",
  async run(context) {
    const nonce = (context.body as { nonce?: unknown } | null)?.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) {
      throw new PayError(400, "invalid_request", "The body must be JSON with a string nonce.");
    }
    context.nonce = nonce;
    const challenge = await loadChallenge(context.db, nonce);
    if (!challenge) throw new PayError(404, "not_found", "No Challenge has this nonce.");
    // A cheap early answer. reserveFunds makes the same check under the Challenge lock.
    if (challenge.buyerOrgId && challenge.buyerOrgId !== context.agent!.orgId) {
      throw new PayError(
        403,
        "challenge_buyer_mismatch",
        "This Challenge was issued to a different buyer.",
      );
    }
    context.challenge = challenge;
  },
};

/** DESIGN.md section 9, step 2. Trips before Policies and Budgets run. */
const breaker: PayStep = {
  name: "breaker",
  async run({ db, breaker: limits, agent, nonce, challenge }) {
    const payment = { agentId: agent!.agentId, orgId: agent!.orgId, nonce: nonce! };
    await checkBreaker(
      db,
      { ...payment, amountMicro: challenge!.amountMicro },
      limits ?? breakerLimitsFromEnv(),
    ).catch((error: unknown) => {
      throw asPayError(error);
    });
  },
};

/** The breaker's race-safe recount, once this payment's hold is committed. */
const breakerRecount: PayStep = {
  name: "breaker-recount",
  async run({ db, breaker: limits, agent, reservation }) {
    const payment = { agentId: agent!.agentId, orgId: agent!.orgId, nonce: reservation!.nonce };
    await confirmBreaker(db, payment, limits ?? breakerLimitsFromEnv()).catch((error: unknown) => {
      throw asPayError(error);
    });
  },
};

const reserve: PayStep = {
  name: "funds",
  async run(context) {
    const { db, config, nonce, agent } = context;
    try {
      context.reservation = await reserveFunds(db, {
        nonce: nonce!,
        agentId: agent!.agentId,
        buyerOrgId: agent!.orgId,
        ttlSeconds: config.receiptTtlSeconds,
      });
    } catch (error) {
      throw asPayError(error);
    }
  },
};

const issueReceipt: PayStep = {
  name: "receipt",
  async run(context) {
    const { config, challenge, reservation, agent } = context;
    // The JWT's expiry can't outlive the hold: the same instant, rounded down to a second.
    // A retry gets the same hold back, so it gets the very same Receipt.
    const exp = Math.floor(reservation!.reservationExpiresAt.getTime() / 1000);
    const amount = reservation!.amountMicro.toString();
    const receipt = signReceipt(
      {
        nonce: reservation!.nonce,
        agentId: agent!.agentId,
        orgId: agent!.orgId,
        sellerId: challenge!.sellerOrgId,
        endpointId: challenge!.endpointId,
        amount,
        exp,
      },
      config.receiptSigningSecret,
    );
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: { url: buildResource(config, challenge!).url },
      accepted: buildRequirements(config, challenge!),
      payload: { receipt },
    };
    context.issued = {
      receipt,
      paymentSignature: encodeHeaderValue(payload),
      amount,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  },
};

/**
 * Phase 5 adds its steps between `challenge` and `funds`, in the order DESIGN.md section 9
 * gives: breaker, then policies, then budgets. The breaker also recounts after `funds`, so
 * a concurrent burst can't slip past it.
 */
export const PAY_STEPS: readonly PayStep[] = [
  authenticateAgent,
  rejectFrozen,
  loadPayableChallenge,
  breaker,
  reserve,
  breakerRecount,
  issueReceipt,
];

/**
 * Runs the pipeline. The first failing step stops it by throwing a PayError. Pass `agent`
 * when the caller has already authenticated the Key; the key step then trusts it.
 */
export async function runPayPipeline(
  deps: PayDeps,
  headers: Headers,
  body: unknown,
  agent?: AuthenticatedAgent,
): Promise<IssuedReceipt> {
  const context: PayContext = { ...deps, headers, body, agent };
  for (const step of PAY_STEPS) await step.run(context);
  return context.issued!;
}

/** A Response for an error raised by {@link runPayPipeline}, or rethrows anything else. */
export function payErrorResponse(error: unknown): Response {
  if (error instanceof PayError) {
    return jsonError(error.status, error.code, error.message, error.details);
  }
  throw error;
}

/**
 * Handles `POST /api/pay`. An unexpected failure is logged here and answered with the
 * documented error body, `500 internal_error`, never with its details.
 */
export async function handlePayRequest(deps: PayDeps, request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  try {
    return Response.json(await runPayPipeline(deps, request.headers, body));
  } catch (error) {
    if (error instanceof PayError) return payErrorResponse(error);
    console.error("POST /api/pay failed", error);
    return jsonError(500, "internal_error", "Something went wrong. Nothing was charged.");
  }
}
