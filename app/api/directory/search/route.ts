import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { DEFAULT_SEARCH_LIMIT, searchDirectory } from "@/lib/directory";
import { jsonError } from "@/lib/http";
import { authenticateRequest } from "@/lib/keys";
import { AI_BUSY_MESSAGE, getLlm, isAiBusy } from "@/lib/llm";

/**
 * Semantic search over Listings: `GET /api/directory/search?q=product+prices&limit=5`.
 * An agent authenticates with its Key. The dashboard's Directory screen (/directory) needs no
 * route: its server components call lib/directory directly. Prices are the caller's own (its
 * enterprise rate where it has one).
 */
export async function GET(request: Request) {
  // Reads the environment, so it must not be prerendered at build time.
  await connection();
  const db = getDb();
  const auth = await authenticateRequest(db, request.headers);
  if (!auth.ok) return jsonError(401, "invalid_key", "Send a valid Key as a Bearer token.");
  const buyerOrgId = auth.orgId;

  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim();
  if (!query) return jsonError(400, "invalid_request", "Add a search, like ?q=product+prices.");
  const limit = Number(params.get("limit") ?? DEFAULT_SEARCH_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) {
    return jsonError(400, "invalid_request", "limit must be a positive whole number.");
  }

  try {
    const results = await searchDirectory(db, getLlm(), { query, buyerOrgId, limit });
    return Response.json({
      results: results.map((r) => ({
        ...r,
        endpoints: r.endpoints.map((e) => ({ ...e, priceMicro: e.priceMicro.toString() })),
      })),
    });
  } catch (error) {
    if (isAiBusy(error)) return jsonError(503, "ai_busy", AI_BUSY_MESSAGE);
    throw error;
  }
}
