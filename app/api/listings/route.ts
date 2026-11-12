import { getPrincipal } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { handleCreateListing } from "@/lib/listings";
import { getLlm } from "@/lib/llm";

/**
 * Creates a Listing from a base URL, with its Endpoints and prices (docs/API.md §6). Only a
 * signed-in seller admin, for their own org. The Listing is live on `/g/{seller}/{path}` at once.
 */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  return handleCreateListing(
    { db: getDb(), llm: getLlm(), appBaseUrl: getEnv().APP_BASE_URL },
    principal,
    request,
  );
}
