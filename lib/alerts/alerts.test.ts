import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { BREAKER_ALERT_TYPE, BreakerTrippedError, tripBreaker } from "../breaker";
import { createBudget } from "../budgets";
import { createDb, type Db } from "../db/client";
import { agents, alerts, orgs } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { handlePayRequest } from "../pay";
import type { PaymentRequired } from "../x402";
import {
  alertsAfter,
  BREAKER_TRIPPED,
  BUDGET_ALERT_TYPE,
  countUnread,
  describeAlertType,
  listAlerts,
  unreadSince,
} from "./index";

const url = inject("testDatabaseUrl");

describe("alert labels", () => {
  it("matches the breaker's own alert type", () => {
    expect(BREAKER_TRIPPED).toBe(BREAKER_ALERT_TYPE);
  });

  it("names each kind, and still shows a type it doesn't know", () => {
    expect(describeAlertType(BREAKER_ALERT_TYPE)).toEqual({
      kind: "breaker",
      label: "Breaker tripped",
    });
    expect(describeAlertType(BUDGET_ALERT_TYPE).kind).toBe("budget");
    expect(describeAlertType("policy_denied").kind).toBe("policy");
    expect(describeAlertType("agent_frozen").kind).toBe("frozen");
    expect(describeAlertType("agent_unfrozen").kind).toBe("unfrozen");
    expect(describeAlertType("invoice_overdue")).toEqual({
      kind: "other",
      label: "Invoice overdue",
    });
  });

  it("counts unread from the cookie's time, else from 24 hours ago", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(unreadSince("2026-11-12T11:00:00.000Z", now).toISOString()).toBe(
      "2026-11-12T11:00:00.000Z",
    );
    expect(unreadSince(undefined, now).toISOString()).toBe("2026-11-11T12:00:00.000Z");
    expect(unreadSince("garbage", now).toISOString()).toBe("2026-11-11T12:00:00.000Z");
  });
});

describe.skipIf(!url)("alerts", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 20 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  async function org() {
    const [row] = await db
      .insert(orgs)
      .values({
        name: "Alerts Org",
        slug: `alerts-${randomUUID()}`,
        kind: "company",
        billing: "prepaid",
      })
      .returning({ id: orgs.id });
    const [agent] = await db
      .insert(agents)
      .values({ orgId: row!.id, name: `bot-${randomUUID().slice(0, 8)}` })
      .returning({ id: agents.id, name: agents.name });
    return { orgId: row!.id, agentId: agent!.id, agentName: agent!.name };
  }

  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

  it("lists only the org's own alerts, newest first, with the Agent's name", async () => {
    const acme = await org();
    const other = await org();
    await db.insert(alerts).values([
      { orgId: acme.orgId, agentId: acme.agentId, type: "t", message: "old", createdAt: ago(30) },
      { orgId: acme.orgId, type: "t", message: "org-wide", createdAt: ago(20) },
      { orgId: acme.orgId, agentId: acme.agentId, type: "t", message: "new", createdAt: ago(10) },
      { orgId: other.orgId, agentId: other.agentId, type: "t", message: "theirs" },
    ]);

    const { alerts: listed } = await listAlerts(db, { orgId: acme.orgId });
    expect(listed.map((a) => a.message)).toEqual(["new", "org-wide", "old"]);
    expect(listed[0]).toMatchObject({ agentId: acme.agentId, agent: acme.agentName });
    expect(listed[1]).toMatchObject({ agentId: null, agent: null });
    expect((await listAlerts(db, { orgId: acme.orgId, limit: 2 })).alerts).toHaveLength(2);
  });

  it("returns only newer alerts after the cursor, newest first", async () => {
    const acme = await org();
    const other = await org();
    await db
      .insert(alerts)
      .values({ orgId: acme.orgId, type: "t", message: "a", createdAt: ago(5) });
    const first = await listAlerts(db, { orgId: acme.orgId });
    expect((await alertsAfter(db, { orgId: acme.orgId, cursor: first.cursor! })).alerts).toEqual(
      [],
    );

    await db.insert(alerts).values([
      { orgId: acme.orgId, type: "t", message: "b", createdAt: ago(2) },
      { orgId: acme.orgId, type: "t", message: "c", createdAt: ago(1) },
      { orgId: other.orgId, type: "t", message: "theirs" },
    ]);
    const next = await alertsAfter(db, { orgId: acme.orgId, cursor: first.cursor! });
    expect(next.alerts.map((a) => a.message)).toEqual(["c", "b"]);
    const again = await alertsAfter(db, { orgId: acme.orgId, cursor: next.cursor });
    expect(again.alerts).toEqual([]);
  });

  it("counts the badge: the org's alerts since the last read", async () => {
    const acme = await org();
    const other = await org();
    await db.insert(alerts).values([
      { orgId: acme.orgId, type: "t", message: "before", createdAt: ago(3600) },
      { orgId: acme.orgId, type: "t", message: "after", createdAt: ago(60) },
      { orgId: acme.orgId, type: "t", message: "after too", createdAt: ago(30) },
      { orgId: other.orgId, type: "t", message: "theirs" },
    ]);
    expect(await countUnread(db, { orgId: acme.orgId, since: ago(600) })).toBe(2);
    expect(await countUnread(db, { orgId: acme.orgId, since: unreadSince(undefined) })).toBe(3);
    expect(await countUnread(db, { orgId: acme.orgId, since: new Date() })).toBe(0);
  });

  it("shows a breaker trip in the list and the badge", async () => {
    const acme = await org();
    const since = ago(1);
    const tripped = new BreakerTrippedError(
      "calls",
      { calls: 51, spentPerMinuteMicro: 0n },
      { maxCalls: 50, windowSeconds: 10, maxMicroPerMinute: 2_000_000n },
    );
    expect(await tripBreaker(db, acme.agentId, tripped)).toBe(true);

    const { alerts: listed } = await listAlerts(db, { orgId: acme.orgId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      type: BREAKER_ALERT_TYPE,
      agent: acme.agentName,
      message: `Circuit breaker froze ${acme.agentName}: 51 calls in 10 s (limit 50).`,
    });
    expect(describeAlertType(listed[0]!.type).label).toBe("Breaker tripped");
    expect(await countUnread(db, { orgId: acme.orgId, since })).toBe(1);
  });

  describe("a Budget blocking payments", () => {
    async function challenge(slug: string) {
      const res = await handleGatewayRequest(
        { db, config },
        new Request(`https://piko.test/g/${slug}/history`),
        { seller: slug, path: ["history"] },
      );
      return ((await res.json()) as PaymentRequired).accepts[0]!.extra.nonce;
    }

    async function pay(key: string, slug: string) {
      return handlePayRequest(
        { db, config },
        new Request("https://piko.test/api/pay", {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: JSON.stringify({ nonce: await challenge(slug) }),
        }),
      );
    }

    const budgetAlerts = (agentId: string) =>
      db.select().from(alerts).where(eq(alerts.agentId, agentId));

    it("writes one alert for a looping Agent, not one per blocked payment", async () => {
      const buyer = await createBuyer(db, 10_000_000n);
      const seller = await createSeller(db, "http://127.0.0.1:1", { priceMicro: 10_000n });
      await createBudget(db, {
        orgId: buyer.orgId,
        scopeType: "agent",
        scopeId: buyer.agentId,
        period: "day",
        maxMicro: 5_000n,
      });

      for (let i = 0; i < 3; i++) expect((await pay(buyer.rawKey, seller.slug)).status).toBe(402);
      const burst = await Promise.all(
        Array.from({ length: 5 }, () => pay(buyer.rawKey, seller.slug)),
      );
      expect(burst.map((r) => r.status)).toEqual([402, 402, 402, 402, 402]);

      const written = await budgetAlerts(buyer.agentId);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        orgId: buyer.orgId,
        type: BUDGET_ALERT_TYPE,
        message: "test-agent hit the agent budget of $0.005 per day. Payments over it are blocked.",
      });
      const { alerts: listed } = await listAlerts(db, { orgId: buyer.orgId });
      expect(listed.map((a) => describeAlertType(a.type).label)).toEqual(["Budget hit"]);
    });

    it("writes no alert when the payment fits", async () => {
      const buyer = await createBuyer(db, 10_000_000n);
      const seller = await createSeller(db, "http://127.0.0.1:1", { priceMicro: 10_000n });
      await createBudget(db, {
        orgId: buyer.orgId,
        scopeType: "agent",
        scopeId: buyer.agentId,
        period: "day",
        maxMicro: 1_000_000n,
      });
      expect((await pay(buyer.rawKey, seller.slug)).status).toBe(200);
      expect(await budgetAlerts(buyer.agentId)).toEqual([]);
    });
  });
});
