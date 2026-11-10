import { handleProductSearch } from "@/lib/demo-sellers/product-search";

export function GET(request: Request): Promise<Response> {
  return handleProductSearch(request);
}
