/**
 * The `POST /api/pay` pipeline (docs/DESIGN.md section 9): an ordered list of steps, each of
 * which can stop the payment by throwing a PayError. Phase 5 inserts the breaker, policy
 * and budget steps into PAY_STEPS, between the Challenge lookup and the funds check.
 * A step whose check must hold under concurrency also pushes it onto `holdChecks`, which
 * reserveFunds runs under the buyer org's lock.
 */
import { eq, sql } from "drizzle-orm";
import {
  breakerLimitsFromEnv,
  BreakerTrippedError,
  checkBreaker,
  confirmBreaker,
  type BreakerLimits,
} from "../breaker";
import { recordBudgetAlert, recordPolicyAlert } from "../alerts";
import { approvalUrls, requestApproval } from "../approvals";
import { BudgetExceededError, enforceBudgets, type BudgetState } from "../budgets";
import type { Db } from "../db/client";
import { challenges, endpoints, listings, orgs } from "../db/schema";
import { jsonError } from "../http";
import { evaluatePolicies, loadPolicies } from "../policy";
import { authenticateRequest, type AuthenticatedAgent } from "../keys";
import {
  InsufficientFundsError,
  LedgerError,
  type DbOrTx,
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
import { formatUsd } from "../money";
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

/** A payment a Budget blocked. The pipeline writes its alert once the payment has stopped. */
class BudgetBlockedError extends PayError {
  constructor(
    public readonly budget: BudgetState,
    message: string,
  ) {
    super(402, "budget_exceeded", message, {
      scope: budget.scope,
      remaining: budget.remainingMicro.toString(),
      budgetId: budget.budgetId,
      period: budget.period,
      category: budget.category,
      max: budget.maxMicro.toString(),
    });
  }
}

/** A payment a Policy blocked. The pipeline writes its alert once the payment has stopped. */
class PolicyBlockedError extends PayError {
  constructor(
    public readonly policyName: string,
    public readonly reason: string,
    policyId: string,
    rule: string,
  ) {
    super(403, "policy_denied", `Blocked by the policy "${policyName}". ${reason}`, {
      policyId,
      rule,
      policy: policyName,
    });
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
  /** Checks to repeat under the buyer org's lock, just before the hold is taken. */
  holdChecks: ((tx: DbOrTx) => Promise<void>)[];
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

/** DESIGN.md section 9, step 3: vendor block and allow, max price, approval above. */
const checkPolicies: PayStep = {
  name: "policy",
  async run({ db, config, agent, challenge, nonce }) {
    const policies = await loadPolicies(db, agent!.orgId);
    if (policies.length === 0) return;
    const [vendor] = await db
      .select({
        sellerSlug: orgs.slug,
        sellerName: orgs.name,
        listingSlug: listings.slug,
        listingName: listings.name,
        category: listings.category,
      })
      .from(endpoints)
      .innerJoin(listings, eq(endpoints.listingId, listings.id))
      .innerJoin(orgs, eq(listings.sellerOrgId, orgs.id))
      .where(eq(endpoints.id, challenge!.endpointId));
    const { category, ...names } = vendor!;
    const decision = evaluatePolicies(policies, {
      orgId: agent!.orgId,
      teamId: agent!.teamId,
      agentId: agent!.agentId,
      vendor: names,
      category,
      priceMicro: challenge!.amountMicro,
    });
    if (decision.outcome === "deny") {
      throw new PolicyBlockedError(
        decision.policyName,
        decision.reason,
        decision.policyId,
        decision.rule,
      );
    }
    if (decision.outcome === "needs_approval") {
      // One Approval per Challenge: a retry or a poll finds the same one.
      const approval = await requestApproval(db, {
        nonce: nonce!,
        agentId: agent!.agentId,
        orgId: agent!.orgId,
        policyId: decision.policyId,
        amountMicro: challenge!.amountMicro,
      });
      if (approval.status === "approved") return; // The rest of the pipeline still runs.
      if (approval.status === "denied") {
        throw new PolicyBlockedError(
          decision.policyName,
          "An org admin denied this payment.",
          decision.policyId,
          "approval_above",
        );
      }
      throw new PayError(
        202,
        "approval_pending",
        `Payments over ${formatUsd(decision.thresholdMicro)} need an org admin's approval.`,
        {
          approvalId: approval.id,
          ...approvalUrls(config.appBaseUrl, approval.id),
          // Autopay callers never saw the Challenge; they need its nonce to pay once approved.
          nonce: nonce!,
          amount: approval.amountMicro.toString(),
          policyId: decision.policyId,
          policy: decision.policyName,
        },
      );
    }
  },
};

const checkBudgets: PayStep = {
  name: "budget",
  async run(context) {
    const { agent, challenge, nonce } = context;
    const enforce = async (db: DbOrTx) => {
      try {
        await enforceBudgets(db, {
          orgId: agent!.orgId,
          teamId: agent!.teamId,
          agentId: agent!.agentId,
          endpointId: challenge!.endpointId,
          amountMicro: challenge!.amountMicro,
          nonce,
        });
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        throw new BudgetBlockedError(error.budget, error.message);
      }
    };
    // An early answer. The same check runs again under the org lock, so concurrent
    // payments can't both fit under one Budget.
    await enforce(context.db);
    context.holdChecks.push(enforce);
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
        beforeHold: async (tx) => {
          for (const check of context.holdChecks) await check(tx);
        },
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
 * Phase 5's steps sit between `challenge` and `funds`, in the order DESIGN.md section 9
 * gives: breaker, then policies (`policy`), then budgets (`budget`, the last before `funds`). The
 * breaker also recounts after `funds`, so a concurrent burst can't slip past it.
 */
export const PAY_STEPS: readonly PayStep[] = [
  authenticateAgent,
  rejectFrozen,
  loadPayableChallenge,
  breaker,
  checkPolicies,
  checkBudgets,
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
  const context: PayContext = { ...deps, headers, body, agent, holdChecks: [] };
  try {
    for (const step of PAY_STEPS) await step.run(context);
  } catch (error) {
    if (error instanceof BudgetBlockedError) await alertBudget(context, error);
    if (error instanceof PolicyBlockedError) await alertPolicy(context, error);
    throw error;
  }
  return context.issued!;
}

/**
 * Tells the org's admins a Budget blocked a payment (P5-08). Written after the payment's
 * transaction is gone, so the alert survives its rollback. A failure here never changes the
 * answer the Agent gets.
 */
async function alertBudget(context: PayContext, error: BudgetBlockedError): Promise<void> {
  try {
    await recordBudgetAlert(context.db, {
      orgId: context.agent!.orgId,
      agentId: context.agent!.agentId,
      budget: error.budget,
    });
  } catch (failure) {
    console.error("Could not write the budget alert", failure);
  }
}

/** Tells the org's admins a Policy blocked a payment, like {@link alertBudget}. */
async function alertPolicy(context: PayContext, error: PolicyBlockedError): Promise<void> {
  try {
    await recordPolicyAlert(context.db, {
      orgId: context.agent!.orgId,
      agentId: context.agent!.agentId,
      policyName: error.policyName,
      reason: error.reason,
    });
  } catch (failure) {
    console.error("Could not write the policy alert", failure);
  }
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
