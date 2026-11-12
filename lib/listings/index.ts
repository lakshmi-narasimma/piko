/**
 * Listing onboarding (BACKLOG P4-01): a seller turns an API's base URL into a Listing with
 * priced Endpoints, reachable at once through the hosted gateway `/g/{seller}/{path}`.
 *
 * - The base URL passes the SSRF guard (lib/gateway/ssrf) before anything is written.
 * - The Listing is embedded for the Directory when it is created. If the embedding model is
 *   busy (AiBusy), the Listing is still created with no vector and `embedded: false`; the
 *   Directory embeds it on its next search (lib/directory embedMissingListings).
 * - The Listing and its Endpoints are written in one transaction.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { endpoints, listings } from "../db/schema";
import { listingText, type EmbeddingLlm } from "../directory";
import { checkUpstreamUrl, type LookupFn } from "../gateway/ssrf";
import { jsonError } from "../http";
import { isAiBusy } from "../llm";
import { formatUsd, parseUsd } from "../money";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const MAX_ENDPOINTS = 50;
/** The highest price per Call a seller may set: $100. */
export const MAX_PRICE_MICRO = 100_000_000n;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
// Root-relative path segments of unreserved characters; no query, fragment or dot segments.
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;

const priceSchema = z.union([
  // Micro-USD as a string of digits, the API's usual form ("2000" = $0.002).
  z.object({ priceMicro: z.string().regex(/^\d{1,12}$/, "priceMicro must be whole micro-USD.") }),
  // Or dollars as a person types them ("0.002"), read with parseUsd.
  z.object({ price: z.string().min(1).max(32) }),
]);

const endpointSchema = z
  .object({
    method: z
      .string()
      .transform((m) => m.toUpperCase())
      .pipe(z.enum(HTTP_METHODS)),
    path: z
      .string()
      .max(200)
      .regex(PATH, "path must start with / and use only letters, digits, '.', '_', '~' and '-'.")
      .refine(
        (p) => p.split("/").every((s) => s !== "." && s !== ".."),
        "path must not contain . or .. segments.",
      ),
    priceMicro: z.string().optional(),
    price: z.string().optional(),
    freeQuota: z.number().int().min(0).max(1_000_000).default(0),
  })
  .transform((endpoint, ctx) => {
    const parsed = priceSchema.safeParse(endpoint);
    let priceMicro: bigint | null = null;
    if ((endpoint.price === undefined) === (endpoint.priceMicro === undefined)) {
      ctx.addIssue({ code: "custom", message: "Give exactly one of price or priceMicro." });
    } else if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "priceMicro must be whole micro-USD." });
    } else if ("priceMicro" in parsed.data) {
      priceMicro = BigInt(parsed.data.priceMicro);
    } else {
      try {
        priceMicro = parseUsd(parsed.data.price);
      } catch {
        ctx.addIssue({ code: "custom", message: `"${endpoint.price}" is not a dollar amount.` });
      }
    }
    if (priceMicro !== null && (priceMicro < 0n || priceMicro > MAX_PRICE_MICRO)) {
      ctx.addIssue({ code: "custom", message: "A price must be between $0 and $100 per Call." });
    }
    return {
      method: endpoint.method,
      path: endpoint.path,
      priceMicro: priceMicro ?? 0n,
      freeQuota: endpoint.freeQuota,
    };
  });

export const createListingSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    category: z.string().trim().min(1).max(60).optional(),
    kind: z.enum(["http", "mcp", "both"]).default("http"),
    slug: z.string().regex(SLUG, "slug must be 1-48 lowercase letters, digits or '-'.").optional(),
    endpoints: z.array(endpointSchema).min(1).max(MAX_ENDPOINTS),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.endpoints.forEach((e, i) => {
      const route = `${e.method} ${e.path}`;
      if (seen.has(route)) {
        ctx.addIssue({
          code: "custom",
          path: ["endpoints", i],
          message: `${route} is listed twice.`,
        });
      }
      seen.add(route);
    });
  });

export type CreateListingInput = z.input<typeof createListingSchema>;

/** The seller org the Listing belongs to (the signed-in seller's own org). */
export interface ListingSeller {
  orgId: string;
  slug: string;
}

export interface CreateListingDeps {
  db: Db;
  llm: EmbeddingLlm;
  /** APP_BASE_URL: gateway URLs are built on it, and its `/api/demo` URLs skip the SSRF check. */
  appBaseUrl: string;
  /** DNS lookup for the SSRF check; tests pass a fake. */
  lookup?: LookupFn;
}

export interface CreatedEndpoint {
  id: string;
  method: string;
  path: string;
  priceMicro: bigint;
  freeQuota: number;
  /** Where a buyer's agent calls it: `${APP_BASE_URL}/g/{seller}{path}`. */
  gatewayUrl: string;
}

export interface CreatedListing {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  kind: "http" | "mcp" | "both";
  baseUrl: string;
  seller: { slug: string };
  /** False when the embedding model was busy; the Directory embeds it on its next search. */
  embedded: boolean;
  endpoints: CreatedEndpoint[];
}

export type ListingErrorCode =
  "invalid_request" | "invalid_base_url" | "blocked_base_url" | "slug_taken" | "route_taken";

export class ListingError extends Error {
  constructor(
    readonly status: number,
    readonly code: ListingErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ListingError";
  }
}

/** A slug made from a Listing's name: "Price History!" becomes "price-history". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "listing";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The requested slug, or the first free one made from the name (`name`, `name-2`, ...). */
async function chooseSlug(
  tx: Tx,
  sellerOrgId: string,
  requested: string | undefined,
  name: string,
) {
  const base = requested ?? slugify(name);
  const taken = new Set(
    (
      await tx
        .select({ slug: listings.slug })
        .from(listings)
        .where(and(eq(listings.sellerOrgId, sellerOrgId), like(listings.slug, `${base}%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  if (requested) {
    throw new ListingError(409, "slug_taken", `You already have a Listing with slug '${base}'.`);
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/** The unique-violation constraint name of a Postgres error, through Drizzle's wrapper. */
function uniqueViolation(error: unknown): string | null {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === "23505") return typeof pg.constraint === "string" ? pg.constraint : "";
  }
  return null;
}

/**
 * Creates a Listing and its Endpoints for `seller`. Throws ListingError for input the
 * seller can fix (validation, a blocked URL, a slug or route already taken).
 */
export async function createListing(
  deps: CreateListingDeps,
  seller: ListingSeller,
  rawInput: unknown,
): Promise<CreatedListing> {
  const parsed = createListingSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new ListingError(400, "invalid_request", issues[0]?.message ?? "Invalid listing.", {
      issues,
    });
  }
  const input = parsed.data;

  const check = await checkUpstreamUrl(input.baseUrl, {
    appBaseUrl: deps.appBaseUrl,
    lookup: deps.lookup,
  });
  if (!check.ok) {
    const blocked = check.reason === "blocked_address" || check.reason === "unresolvable_host";
    throw new ListingError(400, blocked ? "blocked_base_url" : "invalid_base_url", check.message, {
      reason: check.reason,
    });
  }
  if (check.url.search || check.url.hash) {
    throw new ListingError(
      400,
      "invalid_base_url",
      "The base URL must not have a query string or fragment.",
    );
  }
  const baseUrl = check.url.href.replace(/\/+$/, "");

  // Embed before the transaction, so no database transaction waits on the model.
  let embedding: number[] | null = null;
  try {
    embedding = await deps.llm.embed(
      listingText({
        name: input.name,
        description: input.description,
        category: input.category ?? null,
        endpoints: input.endpoints,
      }),
    );
  } catch (error) {
    if (!isAiBusy(error)) throw error;
  }

  try {
    return await deps.db.transaction(async (tx) => {
      const slug = await chooseSlug(tx, seller.orgId, input.slug, input.name);

      const clashes = await tx
        .select({ method: endpoints.method, path: endpoints.pathOrTool })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.sellerOrgId, seller.orgId),
            inArray(
              endpoints.pathOrTool,
              input.endpoints.map((e) => e.path),
            ),
          ),
        );
      const clash = clashes.find((c) =>
        input.endpoints.some((e) => e.method === c.method && e.path === c.path),
      );
      if (clash) throw routeTaken(clash);

      const [listing] = await tx
        .insert(listings)
        .values({
          sellerOrgId: seller.orgId,
          slug,
          name: input.name,
          description: input.description,
          baseUrl,
          kind: input.kind,
          category: input.category ?? null,
          embedding,
        })
        .returning();
      const rows = await tx
        .insert(endpoints)
        .values(
          input.endpoints.map((e) => ({
            listingId: listing!.id,
            method: e.method,
            pathOrTool: e.path,
            priceMicro: e.priceMicro,
            freeQuota: e.freeQuota,
          })),
        )
        .returning();

      const appBase = deps.appBaseUrl.replace(/\/+$/, "");
      return {
        id: listing!.id,
        slug: listing!.slug,
        name: listing!.name,
        description: listing!.description,
        category: listing!.category,
        kind: listing!.kind,
        baseUrl: listing!.baseUrl,
        seller: { slug: seller.slug },
        embedded: embedding !== null,
        endpoints: rows.map((row) => ({
          id: row.id,
          method: row.method,
          path: row.pathOrTool,
          priceMicro: row.priceMicro,
          freeQuota: row.freeQuota,
          gatewayUrl: `${appBase}/g/${seller.slug}${row.pathOrTool}`,
        })),
      };
    });
  } catch (error) {
    // Another request may have taken the slug or a route since the checks above.
    const constraint = uniqueViolation(error);
    if (constraint === "listings_seller_slug_unique") {
      throw new ListingError(409, "slug_taken", "You already have a Listing with that slug.");
    }
    if (constraint?.startsWith("endpoints_")) {
      throw new ListingError(409, "route_taken", "One of these routes is already listed.");
    }
    throw error;
  }
}

function routeTaken(route: { method: string; path: string }) {
  return new ListingError(
    409,
    "route_taken",
    `You already list ${route.method} ${route.path}. A route can be on only one of your Listings, because the gateway URL /g/{seller}/{path} names no Listing.`,
    { method: route.method, path: route.path },
  );
}

/** A CreatedListing as JSON: amounts are micro-USD strings, with a display price. */
export function listingJson(listing: CreatedListing) {
  return {
    ...listing,
    endpoints: listing.endpoints.map((e) => ({
      ...e,
      priceMicro: e.priceMicro.toString(),
      price: formatUsd(e.priceMicro),
    })),
  };
}

/** Who is asking: the signed-in principal's org, area and role, or null when signed out. */
export interface ListingCaller {
  org: { id: string; slug: string };
  area: "wallet" | "org" | "seller";
  role: "admin" | "member";
}

/**
 * `POST /api/listings`. Only a seller org's admin may create a Listing, and only for their
 * own org. Answers 201 with `{ listing }`, or the standard error body (docs/API.md §4).
 */
export async function handleCreateListing(
  deps: CreateListingDeps,
  caller: ListingCaller | null,
  request: Request,
): Promise<Response> {
  if (!caller) return jsonError(401, "unauthenticated", "Sign in first.");
  if (caller.area !== "seller") {
    return jsonError(403, "forbidden", "Only a seller account can create a Listing.");
  }
  if (caller.role !== "admin") {
    return jsonError(403, "forbidden", "Only an admin can create a Listing.");
  }

  const body: unknown = await request.json().catch(() => undefined);
  if (body === undefined) return jsonError(400, "invalid_request", "Send the Listing as JSON.");

  try {
    const listing = await createListing(
      deps,
      { orgId: caller.org.id, slug: caller.org.slug },
      body,
    );
    return Response.json({ listing: listingJson(listing) }, { status: 201 });
  } catch (error) {
    if (error instanceof ListingError) {
      return jsonError(error.status, error.code, error.message, error.details);
    }
    throw error;
  }
}
