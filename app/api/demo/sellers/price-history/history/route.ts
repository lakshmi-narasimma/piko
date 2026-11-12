import { connection } from "next/server";
import { handlePriceHistory } from "@/lib/demo-sellers/price-history";

export async function GET(request: Request): Promise<Response> {
  // Checks the gateway's secret on every request, so it must not be prerendered at build time.
  await connection();
  return handlePriceHistory(request);
}
