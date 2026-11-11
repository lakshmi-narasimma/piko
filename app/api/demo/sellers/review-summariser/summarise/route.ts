import { handleReviewSummary } from "@/lib/demo-sellers/review-summary";

export function POST(request: Request): Promise<Response> {
  return handleReviewSummary(request, "review-summariser");
}
