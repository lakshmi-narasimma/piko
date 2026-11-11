import { handlePriceHistory } from "@/lib/demo-sellers/price-history";

export function GET(request: Request): Response {
  return handlePriceHistory(request);
}
