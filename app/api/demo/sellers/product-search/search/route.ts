import { connection } from "next/server";
import { handleProductSearch } from "@/lib/demo-sellers/product-search";

export async function GET(request: Request): Promise<Response> {
  // Checks the gateway's secret on every request, so it must not be prerendered at build time.
  await connection();
  return handleProductSearch(request);
}
