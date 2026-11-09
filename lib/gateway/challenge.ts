import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { challenges } from "../db/schema";
import { buildPaymentRequired, type PaymentRequired, type X402Config } from "../x402";
import type { GatewayRoute } from "./route";

/** Who a Challenge was issued to. Unknown (null) when the 402 went to a caller with no Key. */
export interface ChallengeBuyer {
  agentId: string;
  orgId: string;
}

export interface IssuedChallenge {
  nonce: string;
  paymentRequired: PaymentRequired;
}

/** Stores a Challenge for this route. The expiry comes from the database clock. */
export async function issueChallenge(
  db: Db,
  config: X402Config,
  route: GatewayRoute,
  buyer: ChallengeBuyer | null,
): Promise<IssuedChallenge> {
  const nonce = `c_${randomBytes(16).toString("base64url")}`;
  const [row] = await db
    .insert(challenges)
    .values({
      nonce,
      endpointId: route.endpointId,
      agentId: buyer?.agentId,
      buyerOrgId: buyer?.orgId,
      amountMicro: route.priceMicro,
      expiresAt: sql`clock_timestamp() + make_interval(secs => ${config.challengeTtlSeconds})`,
    })
    .returning({ expiresAt: challenges.expiresAt });

  return {
    nonce,
    paymentRequired: buildPaymentRequired(config, {
      sellerSlug: route.sellerSlug,
      path: route.path,
      listingName: route.listingName,
      listingDescription: route.listingDescription,
      nonce,
      amountMicro: route.priceMicro,
      expiresAt: row!.expiresAt,
    }),
  };
}
