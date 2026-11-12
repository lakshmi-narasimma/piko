import { handleApprovalPoll } from "@/lib/approvals/poll";
import { getDb } from "@/lib/db";
import { x402ConfigFromEnv } from "@/lib/x402";

export async function GET(request: Request, context: RouteContext<"/api/approvals/[id]">) {
  const { id } = await context.params;
  return handleApprovalPoll({ db: getDb(), config: x402ConfigFromEnv() }, request, id);
}
