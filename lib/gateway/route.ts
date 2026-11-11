import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { endpoints, listings, orgs } from "../db/schema";

/** A seller Endpoint, with what the gateway needs from its Listing and seller. */
export interface GatewayRoute {
  endpointId: string;
  method: string;
  path: string;
  priceMicro: bigint;
  freeQuota: number;
  listingName: string;
  listingDescription: string;
  baseUrl: string;
  sellerOrgId: string;
  sellerSlug: string;
}

/**
 * Finds the Endpoint a request names: `method` and `path` on the seller with this slug.
 * A seller may have the same route on two Listings, so the oldest wins, to stay stable.
 */
export async function findRoute(
  db: Db,
  sellerSlug: string,
  method: string,
  path: string,
): Promise<GatewayRoute | null> {
  const [row] = await db
    .select({
      endpointId: endpoints.id,
      method: endpoints.method,
      path: endpoints.pathOrTool,
      priceMicro: endpoints.priceMicro,
      freeQuota: endpoints.freeQuota,
      listingName: listings.name,
      listingDescription: listings.description,
      baseUrl: listings.baseUrl,
      sellerOrgId: listings.sellerOrgId,
      sellerSlug: orgs.slug,
    })
    .from(endpoints)
    .innerJoin(listings, eq(endpoints.listingId, listings.id))
    .innerJoin(orgs, eq(listings.sellerOrgId, orgs.id))
    .where(
      and(eq(orgs.slug, sellerSlug), eq(endpoints.method, method), eq(endpoints.pathOrTool, path)),
    )
    .orderBy(asc(endpoints.createdAt), asc(endpoints.id))
    .limit(1);
  return row ?? null;
}
