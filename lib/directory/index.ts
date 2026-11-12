/**
 * The Directory: semantic search over Listings (docs/DESIGN.md section 5.3). Each Listing
 * is embedded once, from its name, description, category and endpoints, with pgvector
 * storing the vector and cosine distance ranking it. Listings without a vector are embedded
 * the first time anyone searches, so a freshly seeded or onboarded Listing needs no extra step.
 */
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client";
import { endpoints, listings, orgs, rateOverrides } from "../db/schema";
import { isAiBusy, type Llm } from "../llm";
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
  const results = await semanticSearch(db, llm, input);
  // The search answer keeps its documented shape, so the free quota stays out of it.
  return results.map((r) => ({
    ...r,
    endpoints: r.endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      priceMicro: e.priceMicro,
      price: e.price,
      gatewayPath: e.gatewayPath,
    })),
  }));
}

async function semanticSearch(
  db: Db,
  llm: EmbeddingLlm,
  input: { query: string; buyerOrgId?: string; limit?: number },
): Promise<DirectoryListing[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  await embedMissingListings(db, llm);
  const queryVector = await llm.embed(input.query);

  const distance = cosineDistance(listings.embedding, queryVector);
  const rows = await db
    .select({ ...listingColumns, score: sql<number>`1 - (${distance})` })
    .from(listings)
    .innerJoin(orgs, eq(orgs.id, listings.sellerOrgId))
    .where(isNotNull(listings.embedding))
    .orderBy(distance)
    .limit(limit);
  if (rows.length === 0) return [];

  const priced = await priceEndpoints(db, rows, input.buyerOrgId);
  return rows.map((row) => ({
    ...toResult(row, Number(row.score)),
    endpoints: priced.get(row.id) ?? [],
  }));
}

/** A Directory Endpoint with its free quota, for the Directory screen. */
export interface DirectoryEndpointDetails extends DirectoryEndpoint {
  /** Calls per buyer org that cost nothing before the price applies. */
  freeQuota: number;
}

/** A Listing as the Directory screen shows it: its Endpoints carry their free quotas. */
export interface DirectoryListing extends Omit<DirectoryResult, "endpoints"> {
  endpoints: DirectoryEndpointDetails[];
}

const listingColumns = {
  id: listings.id,
  slug: listings.slug,
  name: listings.name,
  description: listings.description,
  category: listings.category,
  rating: listings.rating,
  kind: listings.kind,
  sellerSlug: orgs.slug,
  sellerName: orgs.name,
};

interface ListingRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  rating: string | null;
  kind: "http" | "mcp" | "both";
  sellerSlug: string;
  sellerName: string;
}

function toResult(row: ListingRow, score: number): Omit<DirectoryResult, "endpoints"> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    rating: row.rating,
    kind: row.kind,
    seller: { slug: row.sellerSlug, name: row.sellerName },
    score,
  };
}

/**
 * Each Listing's Endpoints, oldest first, priced for `buyerOrgId` (its enterprise rate where
 * it has one, else the list price). Keyed by Listing id.
 */
async function priceEndpoints(
  db: Db,
  rows: ReadonlyArray<{ id: string; sellerSlug: string }>,
  buyerOrgId: string | undefined,
): Promise<Map<string, DirectoryEndpointDetails[]>> {
  const byListing = new Map<string, DirectoryEndpointDetails[]>();
  if (rows.length === 0) return byListing;
  const endpointRows = await db
    .select({
      id: endpoints.id,
      listingId: endpoints.listingId,
      method: endpoints.method,
      path: endpoints.pathOrTool,
      priceMicro: endpoints.priceMicro,
      freeQuota: endpoints.freeQuota,
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
  if (buyerOrgId && endpointRows.length > 0) {
    const found = await db
      .select({ endpointId: rateOverrides.endpointId, priceMicro: rateOverrides.priceMicro })
      .from(rateOverrides)
      .where(
        and(
          eq(rateOverrides.buyerOrgId, buyerOrgId),
          inArray(
            rateOverrides.endpointId,
            endpointRows.map((e) => e.id),
          ),
        ),
      );
    for (const row of found) overrides.set(row.endpointId, row.priceMicro);
  }

  const sellerOf = new Map(rows.map((r) => [r.id, r.sellerSlug]));
  for (const e of endpointRows) {
    const priceMicro = overrides.get(e.id) ?? e.priceMicro;
    const list = byListing.get(e.listingId) ?? [];
    list.push({
      method: e.method,
      path: e.path,
      priceMicro,
      price: formatUsd(priceMicro),
      gatewayPath: `/g/${sellerOf.get(e.listingId)}${e.path}`,
      freeQuota: e.freeQuota,
    });
    byListing.set(e.listingId, list);
  }
  return byListing;
}

/** The most Listings the Directory screen shows at once. */
export const BROWSE_LIMIT = 50;
const MAX_KEYWORD_TERMS = 8;

/** A LIKE pattern that matches `term` anywhere, with LIKE's wildcards escaped. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The words of a query, lowercased and deduplicated. */
export function keywordTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_KEYWORD_TERMS);
}

/**
 * Listings whose name, description or category contain any word of `query`, most words
 * matched first, then best rated. The Directory screen's fallback when embeddings are busy.
 * A query with no words lists every Listing, best rated first. Needs no AI.
 */
export async function keywordSearchDirectory(
  db: Db,
  input: { query: string; buyerOrgId?: string; limit?: number },
): Promise<DirectoryListing[]> {
  const limit = Math.min(Math.max(input.limit ?? BROWSE_LIMIT, 1), BROWSE_LIMIT);
  const terms = keywordTerms(input.query);
  const haystack = sql`(${listings.name} || ' ' || ${listings.description} || ' ' || coalesce(${listings.category}, ''))`;
  const matches = terms.map((t) => sql`${haystack} ilike ${likePattern(t)}`);
  // How many of the words a Listing contains. A plain `0` would read as a column number in ORDER BY.
  const hits =
    matches.length > 0
      ? sql<number>`(${sql.join(
          matches.map((m) => sql`(case when ${m} then 1 else 0 end)`),
          sql` + `,
        )})`
      : sql<number>`0::int`;

  const rows = await db
    .select({ ...listingColumns, hits })
    .from(listings)
    .innerJoin(orgs, eq(orgs.id, listings.sellerOrgId))
    .where(matches.length > 0 ? or(...matches) : undefined)
    .orderBy(
      ...(matches.length > 0 ? [desc(hits)] : []),
      sql`${listings.rating} desc nulls last`,
      asc(listings.name),
      asc(listings.id),
    )
    .limit(limit);

  const priced = await priceEndpoints(db, rows, input.buyerOrgId);
  return rows.map((row) => ({
    ...toResult(row, terms.length > 0 ? Number(row.hits) / terms.length : 0),
    endpoints: priced.get(row.id) ?? [],
  }));
}

export interface DirectoryBrowse {
  /**
   * `semantic`: ranked by embeddings. `keyword`: the AI was busy, so plain word matching.
   * `all`: no query, so every Listing, best rated first.
   */
  mode: "semantic" | "keyword" | "all";
  results: DirectoryListing[];
}

/**
 * What the Directory screen shows for `query`: every Listing when it is empty, else the
 * semantic search, falling back to keyword matching when the AI is busy.
 */
export async function browseDirectory(
  db: Db,
  llm: EmbeddingLlm,
  input: { query: string; buyerOrgId?: string },
): Promise<DirectoryBrowse> {
  const query = input.query.trim();
  const { buyerOrgId } = input;
  if (!query) {
    return { mode: "all", results: await keywordSearchDirectory(db, { query: "", buyerOrgId }) };
  }
  try {
    const results = await semanticSearch(db, llm, { query, buyerOrgId, limit: MAX_SEARCH_LIMIT });
    return { mode: "semantic", results };
  } catch (error) {
    if (!isAiBusy(error)) throw error;
    return { mode: "keyword", results: await keywordSearchDirectory(db, { query, buyerOrgId }) };
  }
}

/** One Listing by its seller's slug and its own slug, priced for `buyerOrgId`, or null. */
export async function loadDirectoryListing(
  db: Db,
  input: { sellerSlug: string; slug: string; buyerOrgId?: string },
): Promise<DirectoryListing | null> {
  const [row] = await db
    .select(listingColumns)
    .from(listings)
    .innerJoin(orgs, eq(orgs.id, listings.sellerOrgId))
    .where(and(eq(orgs.slug, input.sellerSlug), eq(listings.slug, input.slug)))
    .limit(1);
  if (!row) return null;
  const priced = await priceEndpoints(db, [row], input.buyerOrgId);
  return { ...toResult(row, 0), endpoints: priced.get(row.id) ?? [] };
}

/** The cheapest Endpoint price of a Listing, or null when it has none. */
export function lowestPriceMicro(listing: { endpoints: Array<{ priceMicro: bigint }> }) {
  let lowest: bigint | null = null;
  for (const e of listing.endpoints)
    if (lowest === null || e.priceMicro < lowest) lowest = e.priceMicro;
  return lowest;
}
