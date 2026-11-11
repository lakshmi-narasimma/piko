import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { calls, challenges } from "../db/schema";
import { EXPIRED_CHALLENGE_GRACE_SECONDS, pruneExpiredChallenges } from "./challenge";
import { handleGatewayRequest } from "./index";

const url = inject("testDatabaseUrl");

describe.skipIf(!url)("gateway: pruning expired Challenges", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 3 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  const longAgo = sql`clock_timestamp() - make_interval(secs => ${EXPIRED_CHALLENGE_GRACE_SECONDS + 60})`;

  async function seedChallenges(endpointId: string, buyer: { agentId: string; orgId: string }) {
    const nonce = () => `c_test_${randomUUID()}`;
    const rows = {
      stale: nonce(),
      inGrace: nonce(),
      live: nonce(),
      reserved: nonce(),
      called: nonce(),
    };
    await db.insert(challenges).values([
      { nonce: rows.stale, endpointId, amountMicro: 2_000n, expiresAt: longAgo },
      {
        nonce: rows.inGrace,
        endpointId,
        amountMicro: 2_000n,
        expiresAt: sql`clock_timestamp() - interval '1 second'`,
      },
      {
        nonce: rows.live,
        endpointId,
        amountMicro: 2_000n,
        expiresAt: sql`clock_timestamp() + interval '1 minute'`,
      },
      {
        nonce: rows.reserved,
        endpointId,
        agentId: buyer.agentId,
        buyerOrgId: buyer.orgId,
        amountMicro: 2_000n,
        expiresAt: longAgo,
        reservedAt: longAgo,
        reservationExpiresAt: longAgo,
      },
      // Not reserved, but a Call points at it (e.g. a blocked Call): it must stay.
      { nonce: rows.called, endpointId, amountMicro: 2_000n, expiresAt: longAgo },
    ]);
    await db.insert(calls).values({
      nonce: rows.called,
      agentId: buyer.agentId,
      buyerOrgId: buyer.orgId,
      endpointId,
      amountMicro: 2_000n,
      status: "blocked",
      blockReason: "policy_denied",
    });
    return rows;
  }

  const remaining = async (nonces: string[]) =>
    (
      await db
        .select({ nonce: challenges.nonce })
        .from(challenges)
        .where(inArray(challenges.nonce, nonces))
    ).map((row) => row.nonce);

  it("deletes only Challenges that expired past the grace period and were never used", async () => {
    const seller = await createSeller(db, "http://127.0.0.1:1");
    const buyer = await createBuyer(db);
    const rows = await seedChallenges(seller.endpointId, buyer);

    const deleted = await pruneExpiredChallenges(db, 10_000);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await remaining(Object.values(rows))).sort()).toEqual(
      [rows.inGrace, rows.live, rows.reserved, rows.called].sort(),
    );
  });

  it("deletes at most one batch per prune", async () => {
    const seller = await createSeller(db, "http://127.0.0.1:1");
    await db.insert(challenges).values(
      Array.from({ length: 5 }, () => ({
        nonce: `c_test_${randomUUID()}`,
        endpointId: seller.endpointId,
        amountMicro: 2_000n,
        expiresAt: longAgo,
      })),
    );

    expect(await pruneExpiredChallenges(db, 2)).toBe(2);
  });

  it("prunes while issuing a 402", async () => {
    const seller = await createSeller(db, "http://127.0.0.1:1");
    const buyer = await createBuyer(db);
    const rows = await seedChallenges(seller.endpointId, buyer);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const res = await handleGatewayRequest(
      { db, config: TEST_GATEWAY_CONFIG },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}${seller.path}`),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
    vi.mocked(Math.random).mockRestore();

    expect(res.status).toBe(402);
    // Only this file makes Challenges stale past the grace period, and far fewer than one
    // batch, so the prune the 402 ran reached ours.
    expect((await remaining(Object.values(rows))).sort()).toEqual(
      [rows.inGrace, rows.live, rows.reserved, rows.called].sort(),
    );
    const issued = await db
      .select({ nonce: challenges.nonce })
      .from(challenges)
      .where(eq(challenges.endpointId, seller.endpointId));
    expect(issued.filter((row) => !row.nonce.startsWith("c_test_"))).toHaveLength(1);
  });
});
