/**
 * Approvals (DESIGN.md section 9, step 3): a payment over an `approval_above` threshold
 * waits for a human. The pay pipeline creates one Approval per Challenge, the agent polls it,
 * and an org admin approves or denies it in the Org console.
 *
 * Approving keeps the Challenge payable for {@link APPROVED_CHALLENGE_TTL_SECONDS}, since a
 * human takes longer than the Challenge's normal lifetime. Nothing here moves money: the
 * approved payment still goes through the whole pay pipeline (breaker, budgets, funds).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, approvals, challenges, endpoints, listings } from "../db/schema";
import type { DbOrTx } from "../ledger";

/** How long an approved Challenge stays payable once a human approves it. */
export const APPROVED_CHALLENGE_TTL_SECONDS = 10 * 60;

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  agentId: string;
  orgId: string;
  policyId: string | null;
  challengeNonce: string;
  amountMicro: bigint;
  status: ApprovalStatus;
  decidedAt: Date | null;
  createdAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApprovalError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "already_decided",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

const columns = {
  id: approvals.id,
  agentId: approvals.agentId,
  orgId: approvals.orgId,
  policyId: approvals.policyId,
  challengeNonce: approvals.challengeNonce,
  amountMicro: approvals.amountMicro,
  status: approvals.status,
  decidedAt: approvals.decidedAt,
  createdAt: approvals.createdAt,
};

/**
 * The Approval for this Challenge, creating a pending one if there is none. Safe under
 * concurrency and on retries: one Challenge never gets two Approvals.
 */
export async function requestApproval(
  db: DbOrTx,
  input: {
    nonce: string;
    agentId: string;
    orgId: string;
    policyId: string;
    amountMicro: bigint;
  },
): Promise<Approval> {
  await db
    .insert(approvals)
    .values({
      challengeNonce: input.nonce,
      agentId: input.agentId,
      orgId: input.orgId,
      policyId: input.policyId,
      amountMicro: input.amountMicro,
    })
    .onConflictDoNothing({ target: approvals.challengeNonce });
  const [row] = await db
    .select(columns)
    .from(approvals)
    .where(eq(approvals.challengeNonce, input.nonce));
  return row!;
}

/** An Approval in this org, or null. An id from another org reads as not found. */
export async function getApproval(db: DbOrTx, orgId: string, id: string): Promise<Approval | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select(columns)
    .from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.orgId, orgId)));
  return row ?? null;
}

export interface PendingApproval {
  id: string;
  agent: string;
  listing: string;
  path: string;
  amountMicro: bigint;
  createdAt: Date;
}

/** The org's pending Approvals, oldest first: the Org console inbox. */
export function listPendingApprovals(db: DbOrTx, orgId: string): Promise<PendingApproval[]> {
  return db
    .select({
      id: approvals.id,
      agent: agents.name,
      listing: listings.name,
      path: endpoints.pathOrTool,
      amountMicro: approvals.amountMicro,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .innerJoin(challenges, eq(challenges.nonce, approvals.challengeNonce))
    .innerJoin(endpoints, eq(endpoints.id, challenges.endpointId))
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
}

/**
 * An org admin approves or denies a pending Approval. The org comes from the signed-in
 * admin, never from the request. Approving also keeps its Challenge payable for
 * {@link APPROVED_CHALLENGE_TTL_SECONDS}, unless it was already paid.
 *
 * @throws ApprovalError `forbidden`, `not_found` or `already_decided`.
 */
export async function decideApproval(
  db: Db,
  actor: { account: { id: string }; org: { id: string }; role: "admin" | "member" },
  id: string,
  decision: "approved" | "denied",
): Promise<Approval> {
  if (actor.role !== "admin") {
    throw new ApprovalError("forbidden", "Only an org admin can decide approvals.");
  }
  if (!UUID.test(id)) throw new ApprovalError("not_found", "No such approval.");

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(columns)
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.orgId, actor.org.id)))
      .for("update");
    if (!current) throw new ApprovalError("not_found", "No such approval.");
    if (current.status !== "pending") {
      throw new ApprovalError("already_decided", `This approval is already ${current.status}.`);
    }

    const [decided] = await tx
      .update(approvals)
      .set({ status: decision, decidedBy: actor.account.id, decidedAt: sql`clock_timestamp()` })
      .where(eq(approvals.id, id))
      .returning(columns);

    if (decision === "approved") {
      await tx
        .update(challenges)
        .set({
          expiresAt: sql`greatest(${challenges.expiresAt}, clock_timestamp() + make_interval(secs => ${APPROVED_CHALLENGE_TTL_SECONDS}))`,
        })
        .where(
          and(eq(challenges.nonce, current.challengeNonce), sql`${challenges.consumedAt} is null`),
        );
    }
    return decided!;
  });
}

/** The poll URL an agent uses, and the console page where a human decides. */
export function approvalUrls(appBaseUrl: string, id: string) {
  return {
    pollUrl: `${appBaseUrl}/api/approvals/${id}`,
    approvalUrl: `${appBaseUrl}/org#approvals`,
  };
}
