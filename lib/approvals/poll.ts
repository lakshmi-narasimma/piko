/**
 * `GET /api/approvals/{id}`: the agent polls its Approval. Once it is approved, the poll runs
 * the pay pipeline for the Approval's Challenge and returns the Receipt, so the agent can
 * retry the gateway request with `PAYMENT-SIGNATURE` straight away. Polling again while the
 * hold is active returns the same Receipt.
 */
import { jsonError } from "../http";
import { authenticateRequest } from "../keys";
import { PayError, runPayPipeline, type PayDeps } from "../pay";
import { approvalUrls, getApproval } from ".";

export async function handleApprovalPoll(
  deps: PayDeps,
  request: Request,
  id: string,
): Promise<Response> {
  const auth = await authenticateRequest(deps.db, request.headers);
  if (!auth.ok) return jsonError(401, "invalid_key", "Missing, wrong or revoked key.");

  const approval = await getApproval(deps.db, auth.orgId, id);
  if (!approval) return jsonError(404, "not_found", "No approval has this id.");

  const body: Record<string, unknown> = {
    id: approval.id,
    status: approval.status,
    amount: approval.amountMicro.toString(),
    nonce: approval.challengeNonce,
    createdAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    ...approvalUrls(deps.config.appBaseUrl, approval.id),
  };
  if (approval.status !== "approved") return Response.json(body);

  try {
    const issued = await runPayPipeline(
      deps,
      new Headers(),
      { nonce: approval.challengeNonce },
      auth,
    );
    return Response.json({ ...body, ...issued });
  } catch (error) {
    if (!(error instanceof PayError)) {
      console.error("GET /api/approvals/{id} failed", error);
      return jsonError(500, "internal_error", "Something went wrong. Nothing was charged.");
    }
    // Approved, but the payment itself stopped (for example a Budget, funds, or it was
    // already used). The approval stands; the reason comes back alongside it.
    return Response.json({
      ...body,
      paymentError: { code: error.code, message: error.message, ...error.details },
    });
  }
}
