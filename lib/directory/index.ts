/**
 * The Directory: semantic search over Listings (docs/DESIGN.md section 5.3). Each Listing
 * is embedded once, from its name, description, category and endpoints, with pgvector
 * storing the vector and cosine distance ranking it. Listings without a vector are embedded
 * the first time anyone searches, so a freshly seeded or onboarded Listing needs no extra step.
 */
import { and, asc, cosineDistance, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { endpoints, listings, orgs, rateOverrides } from "../db/schema";
import type { Llm } from "../llm";
import { formatUsd } from "../money";

export type EmbeddingLlm = Pick<Llm, "embed" | "embedMany">;

export interface DirectoryEndpoint {
  method: string;
  path: string;
  /** What the caller's org pays: its enterprise rate if it has one, else the list price. */
  priceMicro: bigint;
  price: string;
  /** Where an agent sends the request: `/g/{seller}{path}`. */
  gatewayPath: string;
}

export interface DirectoryResult {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  /** 0 to 5, or null when unrated. */
  rating: string | null;
  kind: "http" | "mcp" | "both";
  seller: { slug: string; name: string };
  /** Cosine similarity to the query, 0 to 1. Higher is closer. */
  score: number;
  endpoints: DirectoryEndpoint[];
}

/** The text a Listing is embedded as. */
export function listingText(input: {
  name: string;
  description: string;
  category: string | null;
  endpoints: Array<{ method: string; path: string }>;
}): string {
  const routes = input.endpoints.map((e) => `${e.method} ${e.path}`).join(", ");
  return [
    input.name,
    input.description,
    input.category ? `Category: ${input.category}.` : "",
    routes ? `Endpoints: ${routes}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const EMBED_BATCH = 50;

/**
 * Embeds every Listing that has no vector yet. Returns how many it embedded. Safe to call
 * on every search: with nothing missing it is one cheap query.
 */
export async function embedMissingListings(db: Db, llm: EmbeddingLlm): Promise<number> {
  const missing = await db
    .select({
      id: listings.id,
      name: listings.name,
      description: listings.description,
      category: listings.category,
    })
    .from(listings)
    .where(isNull(listings.embedding))
    .orderBy(asc(listings.createdAt))
    .limit(EMBED_BATCH);
  if (missing.length === 0) return 0;

  const routeRows = await db
    .select({
      listingId: endpoints.listingId,
      method: endpoints.method,
      path: endpoints.pathOrTool,
    })
    .from(endpoints)
    .where(
      inArray(
        endpoints.listingId,
        missing.map((l) => l.id),
      ),
    );
  const texts = missing.map((listing) =>
    listingText({
      ...listing,
      endpoints: routeRows.filter((r) => r.listingId === listing.id),
    }),
  );
  const vectors = await llm.embedMany(texts);
  await Promise.all(
    missing.map((listing, i) =>
      db.update(listings).set({ embedding: vectors[i]! }).where(eq(listings.id, listing.id)),
    ),
  );
  return missing.length;
}

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

/**
 * The Listings closest in meaning to `query`, best first, with the caller's prices. Throws
 * AiBusy (from lib/llm) when the embedding model is busy.
 */
export async function searchDirectory(
  db: Db,
  llm: EmbeddingLlm,
  input: { query: string; buyerOrgId?: string; limit?: number },
): Promise<DirectoryResult[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  await embedMissingListings(db, llm);
  const queryVector = await llm.embed(input.query);

  const distance = cosineDistance(listings.embedding, queryVector);
  const rows = await db
    .select({
      id: listings.id,
      slug: listings.slug,
      name: listings.name,
      description: listings.description,
      category: listings.category,
      rating: listings.rating,
      kind: listings.kind,
      sellerSlug: orgs.slug,
      sellerName: orgs.name,
      score: sql<number>`1 - (${distance})`,
    })
    .from(listings)
    .innerJoin(orgs, eq(orgs.id, listings.sellerOrgId))
    .where(isNotNull(listings.embedding))
    .orderBy(distance)
    .limit(limit);
  if (rows.length === 0) return [];

  const endpointRows = await db
    .select({
      id: endpoints.id,
      listingId: endpoints.listingId,
      method: endpoints.method,
      path: endpoints.pathOrTool,
      priceMicro: endpoints.priceMicro,
    })
    .from(endpoints)
    .where(
      inArray(
        endpoints.listingId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(endpoints.createdAt), asc(endpoints.id));

  const overrides = new Map<string, bigint>();
  if (input.buyerOrgId) {
    const found = await db
      .select({ endpointId: rateOverrides.endpointId, priceMicro: rateOverrides.priceMicro })
      .from(rateOverrides)
      .where(
        and(
          eq(rateOverrides.buyerOrgId, input.buyerOrgId),
          inArray(
            rateOverrides.endpointId,
            endpointRows.map((e) => e.id),
          ),
        ),
      );
    for (const row of found) overrides.set(row.endpointId, row.priceMicro);
  }

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    rating: row.rating,
    kind: row.kind,
    seller: { slug: row.sellerSlug, name: row.sellerName },
    score: Number(row.score),
    endpoints: endpointRows
      .filter((e) => e.listingId === row.id)
      .map((e) => {
        const priceMicro = overrides.get(e.id) ?? e.priceMicro;
        return {
          method: e.method,
          path: e.path,
          priceMicro,
          price: formatUsd(priceMicro),
          gatewayPath: `/g/${row.sellerSlug}${e.path}`,
        };
      }),
  }));
}
