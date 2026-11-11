import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, budgets, calls, endpoints, listings, teams } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { createKey } from "../keys";
import { availableFunds, postCall, refundCall } from "../ledger";
import { handlePayRequest } from "../pay";
import type { PaymentRequired } from "../x402";
import {
  BudgetError,
  budgetStates,
  createBudget,
  enforceBudgets,
  periodWindow,
  type NewBudget,
} from "./index";

const url = inject("testDatabaseUrl");
const UPSTREAM = "http://127.0.0.1:1";
const DOLLAR = 1_000_000n;

describe("periodWindow", () => {
  const created = new Date("2026-01-05T08:00:00Z");

  it("puts a day on UTC midnights", () => {
    expect(periodWindow("day", new Date("2026-03-31T23:59:59.999Z"), created)).toEqual({
      from: new Date("2026-03-31T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
    });
  });

  it("puts a month on the first of the month, across a year end", () => {
    expect(periodWindow("month", new Date("2026-12-31T23:00:00Z"), created)).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
  });

  it("starts a task when its Budget was created, with no end", () => {
    expect(periodWindow("task", new Date("2026-06-01T00:00:00Z"), created)).toEqual({
      from: created,
      to: null,
    });
  });
});

describe.skipIf(!url)("Budgets", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 20 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  async function seller(options: { priceMicro?: bigint; category?: string } = {}) {
    const created = await createSeller(db, UPSTREAM, { priceMicro: options.priceMicro });
    if (options.category) {
      const [endpoint] = await db
        .select({ listingId: endpoints.listingId })
        .from(endpoints)
        .where(eq(endpoints.id, created.endpointId));
      await db
        .update(listings)
        .set({ category: options.category })
        .where(eq(listings.id, endpoint!.listingId));
    }
    return created;
  }

  /** An org (like Acme) with a funded wallet, and an Agent with a key. */
  async function buyer(fundedMicro = 1_000n * DOLLAR) {
    const created = await createBuyer(db, fundedMicro);
    return { ...created, teamId: null as string | null };
  }

  async function team(orgId: string, name = `team-${randomUUID()}`) {
    const [row] = await db.insert(teams).values({ orgId, name }).returning({ id: teams.id });
    return row!.id;
  }

  async function agent(orgId: string, teamId: string | null) {
    const [row] = await db
      .insert(agents)
      .values({ orgId, teamId, name: `agent-${randomUUID()}` })
      .returning({ id: agents.id });
    const key = await createKey(db, row!.id);
    return { orgId, teamId, agentId: row!.id, rawKey: key.rawKey };
  }

  /** A settled Call: its row and its three Ledger entries. */
  async function spend(
    who: { orgId: string; agentId: string },
    to: { orgId: string; endpointId: string },
    amountMicro: bigint,
    createdAt?: Date,
  ) {
    const callId = randomUUID();
    await db.insert(calls).values({
      id: callId,
      agentId: who.agentId,
      buyerOrgId: who.orgId,
      endpointId: to.endpointId,
      amountMicro,
      status: "paid",
      ...(createdAt ? { createdAt } : {}),
    });
    await postCall(db, {
      callId,
      buyerOrgId: who.orgId,
      sellerOrgId: to.orgId,
      priceMicro: amountMicro,
    });
    return callId;
  }

  async function budget(input: Omit<NewBudget, "orgId"> & { orgId: string }) {
    return createBudget(db, input);
  }

  /** Issues a real Challenge through the gateway. */
  async function challenge(to: { slug: string }) {
    const res = await handleGatewayRequest(
      { db, config },
      new Request(`https://piko.test/g/${to.slug}/history`),
      { seller: to.slug, path: ["history"] },
    );
    return ((await res.json()) as PaymentRequired).accepts[0]!.extra.nonce;
  }

  async function pay(key: string, to: { slug: string }) {
    const nonce = await challenge(to);
    return payNonce(key, nonce);
  }

  function payNonce(key: string, nonce: string) {
    return handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce }),
      }),
    );
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: Record<string, unknown> }).error;

  it("blocks an Agent's task budget with 402 budget_exceeded and the right remaining", async () => {
    // Sam: $1.00 per task, $0.995 already spent.
    const sam = await buyer(5n * DOLLAR);
    const search = await seller({ priceMicro: 10_000n });
    const cheap = await seller({ priceMicro: 5_000n });
    const task = await budget({
      orgId: sam.orgId,
      scopeType: "agent",
      scopeId: sam.agentId,
      period: "task",
      maxMicro: DOLLAR,
    });
    await spend(sam, search, 995_000n);

    const blocked = await pay(sam.rawKey, search);

    expect(blocked.status).toBe(402);
    expect(await errorOf(blocked)).toMatchObject({
      code: "budget_exceeded",
      scope: "agent",
      remaining: "5000",
      budgetId: task.id,
      period: "task",
      max: "1000000",
      category: null,
    });
    expect(await availableFunds(db, sam.orgId)).toBe(5n * DOLLAR - 995_000n);

    // Exactly what's left still fits; after that, nothing does.
    expect((await pay(sam.rawKey, cheap)).status).toBe(200);
    const after = await pay(sam.rawKey, cheap);
    expect(after.status).toBe(402);
    expect(await errorOf(after)).toMatchObject({ code: "budget_exceeded", remaining: "0" });
  });

  it("counts a task budget only from when the Budget was saved", async () => {
    const sam = await buyer();
    const to = await seller({ priceMicro: 10_000n });
    await spend(sam, to, 990_000n, new Date(Date.now() - 60_000));
    await budget({
      orgId: sam.orgId,
      scopeType: "agent",
      scopeId: sam.agentId,
      period: "task",
      maxMicro: DOLLAR,
    });

    const [state] = await budgetStates(db, sam);
    expect(state).toMatchObject({ spentMicro: 0n, remainingMicro: DOLLAR });
    expect((await pay(sam.rawKey, to)).status).toBe(200);
  });

  it("blocks a team at its cap even though the org budget has room", async () => {
    const acme = await buyer();
    const marketing = await team(acme.orgId, "Marketing");
    const support = await team(acme.orgId, "Support");
    const researcher = await agent(acme.orgId, marketing);
    const watcher = await agent(acme.orgId, marketing);
    const triage = await agent(acme.orgId, support);
    const search = await seller({ priceMicro: 7_000n });
    await budget({
      orgId: acme.orgId,
      scopeType: "org",
      scopeId: acme.orgId,
      period: "month",
      maxMicro: 300n * DOLLAR,
    });
    await budget({
      orgId: acme.orgId,
      scopeType: "team",
      scopeId: marketing,
      period: "month",
      maxMicro: 50n * DOLLAR,
    });
    // The other Marketing agent used the whole $50.
    await spend(watcher, search, 50n * DOLLAR);

    const blocked = await pay(researcher.rawKey, search);
    expect(blocked.status).toBe(402);
    expect(await errorOf(blocked)).toMatchObject({
      code: "budget_exceeded",
      scope: "team",
      remaining: "0",
      period: "month",
    });

    // Another team isn't held back by Marketing's cap.
    expect((await pay(triage.rawKey, search)).status).toBe(200);
  });

  it("blocks every Agent at the org budget", async () => {
    const acme = await buyer();
    const data = await team(acme.orgId);
    const a = await agent(acme.orgId, data);
    const b = await agent(acme.orgId, null);
    const to = await seller({ priceMicro: 2_000n });
    await budget({
      orgId: acme.orgId,
      scopeType: "org",
      scopeId: acme.orgId,
      period: "day",
      maxMicro: 5_000n,
    });
    await spend(a, to, 2_000n);
    await spend(b, to, 2_000n);

    const blocked = await pay(b.rawKey, to);
    expect(blocked.status).toBe(402);
    expect(await errorOf(blocked)).toMatchObject({ scope: "org", remaining: "1000" });
  });

  it("reports the agent budget before the team and org ones", async () => {
    const acme = await buyer();
    const t = await team(acme.orgId);
    const a = await agent(acme.orgId, t);
    const to = await seller({ priceMicro: 2_000n });
    for (const [scopeType, scopeId] of [
      ["org", acme.orgId],
      ["team", t],
      ["agent", a.agentId],
    ] as const) {
      await budget({ orgId: acme.orgId, scopeType, scopeId, period: "month", maxMicro: 1_000n });
    }

    const blocked = await pay(a.rawKey, to);
    expect(await errorOf(blocked)).toMatchObject({ scope: "agent" });
  });

  it("splits day and month periods on UTC boundaries", async () => {
    const who = await buyer();
    const to = await seller();
    const lastOfMarch = new Date("2026-03-31T23:59:59.999Z");
    const firstOfApril = new Date("2026-04-01T00:00:00.000Z");
    const secondOfApril = new Date("2026-04-02T10:00:00.000Z");
    await spend(who, to, 1_000n, lastOfMarch);
    await spend(who, to, 20_000n, firstOfApril);
    await spend(who, to, 300_000n, secondOfApril);
    for (const period of ["day", "month"] as const) {
      await db.insert(budgets).values({
        orgId: who.orgId,
        scopeType: "agent",
        scopeId: who.agentId,
        period,
        maxMicro: DOLLAR,
      });
    }

    const spent = async (at: Date) =>
      Object.fromEntries(
        (await budgetStates(db, who, { at })).map((s) => [s.period, s.spentMicro]),
      );

    expect(await spent(new Date("2026-03-31T12:00:00Z"))).toEqual({ day: 1_000n, month: 1_000n });
    expect(await spent(new Date("2026-04-01T12:00:00Z"))).toEqual({
      day: 20_000n,
      month: 320_000n,
    });
    expect(await spent(new Date("2026-04-02T23:59:59Z"))).toEqual({
      day: 300_000n,
      month: 320_000n,
    });
    expect(await spent(new Date("2026-05-01T00:00:00Z"))).toEqual({ day: 0n, month: 0n });
  });

  it("applies a category budget only to Listings in that category", async () => {
    const acme = await buyer();
    const marketing = await team(acme.orgId);
    const a = await agent(acme.orgId, marketing);
    const search = await seller({ priceMicro: 10_000n, category: "search" });
    const reviews = await seller({ priceMicro: 10_000n, category: "reviews" });
    const other = await seller({ priceMicro: 10_000n });
    await budget({
      orgId: acme.orgId,
      scopeType: "team",
      scopeId: marketing,
      period: "month",
      maxMicro: 25_000n,
      category: "Search",
    });
    // Spend outside the category doesn't use the search budget.
    await spend(a, reviews, 500_000n);
    await spend(a, other, 500_000n);
    await spend(a, search, 10_000n);

    expect((await pay(a.rawKey, search)).status).toBe(200); // 20,000 of 25,000
    const blocked = await pay(a.rawKey, search);
    expect(blocked.status).toBe(402);
    expect(await errorOf(blocked)).toMatchObject({
      scope: "team",
      category: "Search",
      remaining: "5000",
    });
    expect((await pay(a.rawKey, reviews)).status).toBe(200);
    expect((await pay(a.rawKey, other)).status).toBe(200);
  });

  it("nets refunds out of spend", async () => {
    const who = await buyer();
    const to = await seller();
    await budget({
      orgId: who.orgId,
      scopeType: "agent",
      scopeId: who.agentId,
      period: "day",
      maxMicro: 10_000n,
    });
    const callId = await spend(who, to, 8_000n);
    await spend(who, to, 1_000n);
    await refundCall(db, callId);

    const [state] = await budgetStates(db, who);
    expect(state).toMatchObject({ spentMicro: 1_000n, remainingMicro: 9_000n });
  });

  it("counts held amounts, but not a retried payment's own hold", async () => {
    const who = await buyer();
    const to = await seller({ priceMicro: 4_000n });
    await budget({
      orgId: who.orgId,
      scopeType: "agent",
      scopeId: who.agentId,
      period: "day",
      maxMicro: 8_000n,
    });
    await spend(who, to, 4_000n);
    const nonce = await challenge(to);

    const first = await payNonce(who.rawKey, nonce);
    expect(first.status).toBe(200);
    const [state] = await budgetStates(db, who);
    expect(state).toMatchObject({ spentMicro: 4_000n, heldMicro: 4_000n, remainingMicro: 0n });

    // The retry gets its Receipt back; a new payment doesn't fit.
    const retry = await payNonce(who.rawKey, nonce);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    const next = await pay(who.rawKey, to);
    expect(next.status).toBe(402);
    expect(await errorOf(next)).toMatchObject({ code: "budget_exceeded", remaining: "0" });
  });

  it("never lets concurrent payments take a budget over its cap", async () => {
    const who = await buyer();
    const to = await seller({ priceMicro: 2_000n });
    await budget({
      orgId: who.orgId,
      scopeType: "agent",
      scopeId: who.agentId,
      period: "day",
      maxMicro: 10_000n,
    });
    const nonces = await Promise.all(Array.from({ length: 12 }, () => challenge(to)));

    const results = await Promise.all(nonces.map((nonce) => payNonce(who.rawKey, nonce)));

    const statuses = results.map((res) => res.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 402)).toHaveLength(7);
    for (const res of results.filter((r) => r.status === 402)) {
      expect(await errorOf(res)).toMatchObject({ code: "budget_exceeded" });
    }
    const [state] = await budgetStates(db, who);
    expect(state).toMatchObject({ heldMicro: 10_000n, remainingMicro: 0n });
  });

  it("rejects a Budget whose scope is in another org", async () => {
    const acme = await buyer();
    const other = await buyer();
    const otherTeam = await team(other.orgId);
    const base = { orgId: acme.orgId, period: "month", maxMicro: DOLLAR } as const;

    for (const scope of [
      { scopeType: "agent", scopeId: other.agentId },
      { scopeType: "team", scopeId: otherTeam },
      { scopeType: "org", scopeId: other.orgId },
      { scopeType: "agent", scopeId: randomUUID() },
    ] as const) {
      await expect(createBudget(db, { ...base, ...scope })).rejects.toMatchObject({
        code: "scope_not_found",
      });
    }
    await expect(
      createBudget(db, { ...base, scopeType: "agent", scopeId: acme.agentId, maxMicro: -1n }),
    ).rejects.toBeInstanceOf(BudgetError);
    expect(await db.select().from(budgets).where(eq(budgets.orgId, acme.orgId))).toHaveLength(0);
  });

  it("ignores a Budget row that names another org's Agent", async () => {
    const acme = await buyer();
    const other = await buyer();
    const to = await seller();
    // Written around createBudget: Acme's row names the other org's Agent.
    await db.insert(budgets).values({
      orgId: acme.orgId,
      scopeType: "agent",
      scopeId: other.agentId,
      period: "day",
      maxMicro: 0n,
    });

    expect(await budgetStates(db, other)).toEqual([]);
    await expect(
      enforceBudgets(db, { ...other, endpointId: to.endpointId, amountMicro: 2_000n }),
    ).resolves.toBeUndefined();
    expect((await pay(other.rawKey, to)).status).toBe(200);
  });
});
