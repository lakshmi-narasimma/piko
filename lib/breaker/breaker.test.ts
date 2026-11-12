import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, alerts, challenges, orgs, teams } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { createKey } from "../keys";
import { handlePayRequest } from "../pay";
import type { PaymentRequired } from "../x402";
import { brokenLimit, type BreakerLimits } from "./index";

const url = inject("testDatabaseUrl");

const PRICE = 2_000n;
const UPSTREAM = "http://127.0.0.1:1";

describe("brokenLimit", () => {
  const limits: BreakerLimits = { maxCalls: 3, windowSeconds: 10, maxMicroPerMinute: 10_000n };

  it("allows a window at the limits and names the one broken", () => {
    expect(brokenLimit({ calls: 3, spentPerMinuteMicro: 10_000n }, limits)).toBeNull();
    expect(brokenLimit({ calls: 4, spentPerMinuteMicro: 0n }, limits)).toBe("calls");
    expect(brokenLimit({ calls: 1, spentPerMinuteMicro: 10_001n }, limits)).toBe("spend");
  });
});

describe.skipIf(!url)("circuit breaker in POST /api/pay", () => {
  let db: Db;
  let seller: Awaited<ReturnType<typeof createSeller>>;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 20 });
    seller = await createSeller(db, UPSTREAM, { priceMicro: PRICE });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** A fresh anonymous Challenge for the test seller's endpoint. */
  async function challenge(): Promise<string> {
    const res = await handleGatewayRequest(
      { db, config },
      new Request(`https://piko.test/g/${seller.slug}/history`),
      { seller: seller.slug, path: ["history"] },
    );
    const paymentRequired = (await res.json()) as PaymentRequired;
    return paymentRequired.accepts[0]!.extra.nonce;
  }

  function pay(key: string, nonce: string, breaker?: BreakerLimits) {
    return handlePayRequest(
      { db, config, breaker },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce }),
      }),
    );
  }

  async function payNew(key: string, breaker?: BreakerLimits) {
    return pay(key, await challenge(), breaker);
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: Record<string, unknown> }).error;

  async function frozenAt(agentId: string) {
    const [row] = await db
      .select({ frozenAt: agents.frozenAt })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row!.frozenAt;
  }

  const alertsOf = (agentId: string) => db.select().from(alerts).where(eq(alerts.agentId, agentId));

  /** Active holds, the ones a Receipt was issued for and not released. */
  async function activeHolds(agentId: string) {
    const rows = await db
      .select({ nonce: challenges.nonce })
      .from(challenges)
      .where(
        and(
          eq(challenges.agentId, agentId),
          isNotNull(challenges.reservedAt),
          isNull(challenges.consumedAt),
          gt(challenges.reservationExpiresAt, sql`clock_timestamp()`),
        ),
      );
    return rows.length;
  }

  const small = (overrides: Partial<BreakerLimits> = {}): BreakerLimits => ({
    maxCalls: 3,
    windowSeconds: 10,
    maxMicroPerMinute: 1_000_000n,
    ...overrides,
  });

  it("F6: loop-bot over 50 calls in 10 s gets 429, is frozen with one alert, then gets 423", async () => {
    // The default limits from the environment: 50 calls per 10 s.
    const buyer = await createBuyer(db, 1_000_000n);
    await db.update(agents).set({ name: "loop-bot" }).where(eq(agents.id, buyer.agentId));

    for (let call = 1; call <= 50; call++) {
      const res = await payNew(buyer.rawKey);
      expect(res.status, `call ${call}`).toBe(200);
    }

    const tripped = await payNew(buyer.rawKey);
    expect(tripped.status).toBe(429);
    expect(await errorOf(tripped)).toMatchObject({
      code: "breaker_tripped",
      reason: "calls",
      calls: 51,
      windowSeconds: 10,
      spentPerMinute: (51n * PRICE).toString(),
    });
    expect(await frozenAt(buyer.agentId)).toBeInstanceOf(Date);
    const written = await alertsOf(buyer.agentId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ orgId: buyer.orgId, type: "breaker_tripped" });
    expect(written[0]!.message).toContain("loop-bot");
    // The tripping payment reserved nothing.
    expect(await activeHolds(buyer.agentId)).toBe(50);

    const next = await payNew(buyer.rawKey);
    expect(next.status).toBe(423);
    expect(await errorOf(next)).toMatchObject({ code: "agent_frozen", scope: "agent" });
    expect(await alertsOf(buyer.agentId)).toHaveLength(1);
    // 50+ requests; the full suite seeds 12,000 spend Calls in parallel, which can pass 5 s.
  }, 30_000);

  it("lets an agent pay up to the call limit", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    for (let call = 0; call < 3; call++) {
      expect((await payNew(buyer.rawKey, small())).status).toBe(200);
    }
    expect(await frozenAt(buyer.agentId)).toBeNull();
    expect(await alertsOf(buyer.agentId)).toHaveLength(0);
  });

  it("counts a retried nonce once", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const nonce = await challenge();
    const limits = small({ maxCalls: 1 });
    expect((await pay(buyer.rawKey, nonce, limits)).status).toBe(200);
    expect((await pay(buyer.rawKey, nonce, limits)).status).toBe(200);
    expect(await frozenAt(buyer.agentId)).toBeNull();
  });

  it("trips on the dollars-per-minute limit", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const limits = small({ maxCalls: 100, maxMicroPerMinute: 5_000n });
    expect((await payNew(buyer.rawKey, limits)).status).toBe(200);
    expect((await payNew(buyer.rawKey, limits)).status).toBe(200);

    const tripped = await payNew(buyer.rawKey, limits);
    expect(tripped.status).toBe(429);
    expect(await errorOf(tripped)).toMatchObject({
      code: "breaker_tripped",
      reason: "spend",
      calls: 3,
      spentPerMinute: "6000",
    });
    expect(await frozenAt(buyer.agentId)).toBeInstanceOf(Date);
    const [alert] = await alertsOf(buyer.agentId);
    expect(alert!.message).toContain("$0.006 in one minute (limit $0.005)");
    expect((await payNew(buyer.rawKey, limits)).status).toBe(423);
  });

  it("stops counting Calls once they slide out of the window", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const limits = small();
    for (let call = 0; call < 3; call++) {
      expect((await payNew(buyer.rawKey, limits)).status).toBe(200);
    }
    // Age those holds past the 10 s window, but not past the minute.
    await db
      .update(challenges)
      .set({
        reservedAt: sql`${challenges.reservedAt} - interval '11 seconds'`,
        reservationExpiresAt: sql`${challenges.reservationExpiresAt} - interval '11 seconds'`,
      })
      .where(eq(challenges.agentId, buyer.agentId));

    for (let call = 0; call < 3; call++) {
      expect((await payNew(buyer.rawKey, limits)).status).toBe(200);
    }
    expect((await payNew(buyer.rawKey, limits)).status).toBe(429);
  });

  it("counts a hold released after an upstream failure: it was still an attempt", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const limits = small({ maxCalls: 1 });
    expect((await payNew(buyer.rawKey, limits)).status).toBe(200);
    await db
      .update(challenges)
      .set({ reservationExpiresAt: sql`clock_timestamp()` })
      .where(eq(challenges.agentId, buyer.agentId));
    expect((await payNew(buyer.rawKey, limits)).status).toBe(429);
  });

  it("lets no concurrent burst past the limit, and writes one alert", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const limits = small({ maxCalls: 5 });
    const nonces = await Promise.all(Array.from({ length: 20 }, () => challenge()));

    const responses = await Promise.all(nonces.map((nonce) => pay(buyer.rawKey, nonce, limits)));
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(5);
    expect(statuses.every((status) => [200, 423, 429].includes(status))).toBe(true);
    expect(statuses).toContain(429);
    expect(await activeHolds(buyer.agentId)).toBe(statuses.filter((s) => s === 200).length);
    expect(await frozenAt(buyer.agentId)).toBeInstanceOf(Date);
    expect(await alertsOf(buyer.agentId)).toHaveLength(1);
  });

  it("lets no concurrent burst past the spend limit, and writes one alert", async () => {
    const buyer = await createBuyer(db, 1_000_000n);
    const limits = small({ maxCalls: 100, maxMicroPerMinute: 5n * PRICE });
    const nonces = await Promise.all(Array.from({ length: 20 }, () => challenge()));

    const responses = await Promise.all(nonces.map((nonce) => pay(buyer.rawKey, nonce, limits)));
    const statuses = responses.map((res) => res.status);
    const paid = statuses.filter((status) => status === 200).length;

    expect(paid).toBeLessThanOrEqual(5);
    expect(statuses.every((status) => [200, 423, 429].includes(status))).toBe(true);
    expect(statuses).toContain(429);
    expect(await activeHolds(buyer.agentId)).toBe(paid);
    expect(await frozenAt(buyer.agentId)).toBeInstanceOf(Date);
    expect(await alertsOf(buyer.agentId)).toHaveLength(1);
  });

  it("answers a team- or org-frozen agent with 423 before the breaker runs", async () => {
    // With no calls allowed, any payment that reached the breaker would trip it.
    const limits = small({ maxCalls: 0 });
    const control = await createBuyer(db, 1_000_000n);
    expect((await payNew(control.rawKey, limits)).status).toBe(429);

    const inTeam = await createBuyer(db, 1_000_000n);
    const [team] = await db
      .insert(teams)
      .values({ orgId: inTeam.orgId, name: "frozen-team", frozenAt: new Date() })
      .returning({ id: teams.id });
    await db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, inTeam.agentId));

    const inOrg = await createBuyer(db, 1_000_000n);
    await db.update(orgs).set({ frozenAt: new Date() }).where(eq(orgs.id, inOrg.orgId));

    for (const [buyer, scope] of [
      [inTeam, "team"],
      [inOrg, "org"],
    ] as const) {
      const res = await payNew(buyer.rawKey, limits);
      expect(res.status).toBe(423);
      expect(await errorOf(res)).toMatchObject({ code: "agent_frozen", scope });
      expect(await frozenAt(buyer.agentId)).toBeNull();
      expect(await alertsOf(buyer.agentId)).toHaveLength(0);
      expect(await activeHolds(buyer.agentId)).toBe(0);
    }
  });

  it("leaves other agents alone, in the same org and in others", async () => {
    const tripped = await createBuyer(db, 1_000_000n);
    const other = await createBuyer(db, 1_000_000n);
    const [sibling] = await db
      .insert(agents)
      .values({ orgId: tripped.orgId, name: "sibling" })
      .returning({ id: agents.id });
    const siblingKey = await createKey(db, sibling!.id);
    const limits = small({ maxCalls: 1 });

    expect((await payNew(tripped.rawKey, limits)).status).toBe(200);
    expect((await payNew(tripped.rawKey, limits)).status).toBe(429);

    expect((await payNew(siblingKey.rawKey, limits)).status).toBe(200);
    expect((await payNew(other.rawKey, limits)).status).toBe(200);
    expect(await frozenAt(sibling!.id)).toBeNull();
    expect(await frozenAt(other.agentId)).toBeNull();
  });
});
