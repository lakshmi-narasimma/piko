import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createBuyer, createSeller, stubGatewayEnv } from "@/test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, ledgerEntries, listings, orgs } from "../db/schema";
import { recentCalls } from "../calls/feed";
import { balanceOf, postCall } from "../ledger";
import {
  getSimulationState,
  NotSeededError,
  resetSimulation,
  SIMULATION_MAX_CALLS,
  SIMULATION_MAX_DURATION_MS,
  startSimulation,
  stopSimulation,
  tick,
  type WorldScope,
} from "./simulate";

const url = inject("testDatabaseUrl");

/** A seeded PRNG (mulberry32), so a run is repeatable. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function createInvoicedBuyer(db: Db, creditLimitMicro: bigint, agentNames: string[]) {
  const [org] = await db
    .insert(orgs)
    .values({
      name: "Sim Buyer",
      slug: `sim-buyer-${randomUUID()}`,
      kind: "company",
      billing: "invoiced",
      creditLimitMicro,
    })
    .returning({ id: orgs.id });
  const rows = await db
    .insert(agents)
    .values(agentNames.map((name) => ({ orgId: org!.id, name })))
    .returning({ id: agents.id });
  return { orgId: org!.id, agentIds: rows.map((row) => row.id) };
}

/** Waits for real time to pass, so database work finishes while timers are faked. */
const realSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await realSleep(20);
  }
}

describe.skipIf(!url)("simulated traffic", () => {
  let db: Db;
  let scope: WorldScope;
  let acme: Awaited<ReturnType<typeof createInvoicedBuyer>>;
  let sam: Awaited<ReturnType<typeof createBuyer>>;
  let sellers: Awaited<ReturnType<typeof createSeller>>[];
  let cheap: Awaited<ReturnType<typeof createSeller>>;
  /** A live (not simulated) Call with its entries, written before any simulation runs. */
  let live: { callId: string };

  async function simulatedCalls(orgIds: string[]) {
    return db.select().from(calls).where(inArray(calls.buyerOrgId, orgIds));
  }

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!);
    acme = await createInvoicedBuyer(db, 500_000_000n, ["a1", "a2", "a3"]);
    sam = await createBuyer(db, 5_000_000n);
    sellers = [
      await createSeller(db, "https://sim.example", { priceMicro: 10_000n, path: "/search" }),
      await createSeller(db, "https://sim.example", { priceMicro: 5_000n, path: "/summarise" }),
      await createSeller(db, "https://sim.example", { priceMicro: 2_000n, path: "/history" }),
    ];
    cheap = await createSeller(db, "https://sim.example", { priceMicro: 3_000n });
    await db.update(listings).set({ rating: "2.1" }).where(eq(listings.sellerOrgId, cheap.orgId));
    scope = {
      buyerOrgIds: [acme.orgId, sam.orgId],
      sellerOrgIds: [...sellers.map((s) => s.orgId), cheap.orgId],
    };

    live = { callId: randomUUID() };
    await db.insert(calls).values({
      id: live.callId,
      agentId: sam.agentId,
      buyerOrgId: sam.orgId,
      endpointId: sellers[0]!.endpointId,
      amountMicro: 10_000n,
      status: "paid",
      upstreamStatus: 200,
      latencyMs: 90,
    });
    await postCall(db, {
      callId: live.callId,
      buyerOrgId: sam.orgId,
      sellerOrgId: sellers[0]!.orgId,
      priceMicro: 10_000n,
    });
  });

  afterEach(async () => {
    resetSimulation();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // A tick already in flight when the test ended finishes writing its Calls: let it.
    await realSleep(300);
  });

  afterAll(() => {
    resetSimulation();
  });

  describe("a tick", () => {
    it("writes 1 to 3 simulated Calls, only for invoiced orgs, and no live Call is touched", async () => {
      const [liveBefore] = await db.select().from(calls).where(eq(calls.id, live.callId));
      const samBalance = await balanceOf(db, { type: "wallet", orgId: sam.orgId });
      const random = prng(7);
      const counts = new Set<number>();
      for (let i = 0; i < 20; i++) counts.add(await tick(db, { scope, random }));
      expect([...counts].every((n) => n >= 1 && n <= 3)).toBe(true);
      expect(counts.size).toBeGreaterThan(1);

      const made = await simulatedCalls([acme.orgId]);
      expect(made.length).toBeGreaterThanOrEqual(20);
      expect(made.every((call) => call.simulated)).toBe(true);
      expect(made.every((call) => acme.agentIds.includes(call.agentId))).toBe(true);
      expect(made.every((call) => call.nonce === null)).toBe(true);

      // Sam is a real prepaid wallet: never a simulated buyer. His live Call is untouched.
      expect(await simulatedCalls([sam.orgId])).toHaveLength(1);
      expect(await balanceOf(db, { type: "wallet", orgId: sam.orgId })).toBe(samBalance);
      const [liveAfter] = await db.select().from(calls).where(eq(calls.id, live.callId));
      expect(liveAfter).toEqual(liveBefore);
      expect(liveAfter!.simulated).toBe(false);
    });

    it("gives each paid Call three balanced entries and a refunded or blocked one none", async () => {
      const random = prng(11);
      for (let i = 0; i < 80; i++) await tick(db, { scope, random });

      const made = await simulatedCalls([acme.orgId]);
      const byStatus = Object.groupBy(made, (call) => call.status);
      expect(byStatus.paid?.length).toBeGreaterThan(0);
      expect(byStatus.refunded?.length).toBeGreaterThan(0);
      expect(byStatus.blocked?.length).toBeGreaterThan(0);

      const entries = await db
        .select()
        .from(ledgerEntries)
        .where(
          inArray(
            ledgerEntries.refId,
            made.map((call) => call.id),
          ),
        );
      const entriesOf = (id: string) => entries.filter((entry) => entry.refId === id);

      for (const call of byStatus.paid!) {
        const rows = entriesOf(call.id);
        expect(rows.map((row) => row.accountType).sort()).toEqual(["platform", "seller", "wallet"]);
        expect(new Set(rows.map((row) => row.txnId)).size).toBe(1);
        expect(rows.every((row) => row.reason === "call")).toBe(true);
        expect(rows.reduce((sum, row) => sum + row.amountMicro, 0n)).toBe(0n);
        expect(rows.find((row) => row.accountType === "wallet")).toMatchObject({
          orgId: acme.orgId,
          amountMicro: -call.amountMicro,
        });
        expect(call.upstreamStatus).toBe(200);
        expect(call.latencyMs).toBeGreaterThan(0);
      }
      for (const call of [...byStatus.refunded!, ...byStatus.blocked!]) {
        expect(entriesOf(call.id)).toHaveLength(0);
      }
      for (const call of byStatus.refunded!) {
        expect(call.upstreamStatus === null || call.upstreamStatus >= 500).toBe(true);
      }
      for (const call of byStatus.blocked!) expect(call.blockReason).toBeTruthy();

      // Low-rated listings are never bought, only refused.
      const bought = byStatus.paid!.concat(byStatus.refunded!);
      expect(bought.some((call) => call.endpointId === cheap.endpointId)).toBe(false);
      expect(
        byStatus
          .blocked!.filter((call) => call.endpointId === cheap.endpointId)
          .every((call) => call.blockReason === "policy_denied"),
      ).toBe(true);
    });

    it("never takes the buyer's wallet below its credit limit", async () => {
      // $0.02 of credit against Calls of $0.002 to $0.01: a few fit, then the rest are blocked.
      const tight = await createInvoicedBuyer(db, 20_000n, ["only-agent"]);
      const tightScope = { buyerOrgIds: [tight.orgId], sellerOrgIds: scope.sellerOrgIds };
      const random = prng(3);
      for (let i = 0; i < 25; i++) {
        await tick(db, { scope: tightScope, random });
        expect(await balanceOf(db, { type: "wallet", orgId: tight.orgId })).toBeGreaterThanOrEqual(
          -20_000n,
        );
      }
      const made = await simulatedCalls([tight.orgId]);
      expect(made.some((call) => call.status === "paid")).toBe(true);
      const broke = made.filter((call) => call.blockReason === "insufficient_funds");
      expect(broke.length).toBeGreaterThan(0);
      for (const call of broke) {
        const rows = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, call.id));
        expect(rows).toHaveLength(0);
      }
    });

    it("shows up in the live feed flagged simulated, while a live Call is not", async () => {
      const random = prng(13);
      for (let i = 0; i < 3; i++) await tick(db, { scope, random });
      const buyerFeed = await recentCalls(db, { orgId: acme.orgId, side: "buyer", limit: 50 });
      expect(buyerFeed.calls.length).toBeGreaterThan(0);
      expect(buyerFeed.calls.every((call) => call.simulated)).toBe(true);

      const samFeed = await recentCalls(db, { orgId: sam.orgId, side: "buyer" });
      expect(samFeed.calls.map((call) => [call.id, call.simulated])).toEqual([
        [live.callId, false],
      ]);
      // Sellers see the simulated Calls they were paid for, flagged the same way.
      const sellerFeed = await recentCalls(db, {
        orgId: sellers[0]!.orgId,
        side: "seller",
        limit: 100,
      });
      for (const call of sellerFeed.calls) expect(call.simulated).toBe(call.id !== live.callId);
    });

    it("blocks a frozen agent instead of charging it", async () => {
      const frozen = await createInvoicedBuyer(db, 500_000_000n, ["frozen-bot"]);
      await db.update(agents).set({ frozenAt: new Date() }).where(eq(agents.orgId, frozen.orgId));
      const random = prng(5);
      for (let i = 0; i < 5; i++) {
        await tick(db, {
          scope: { buyerOrgIds: [frozen.orgId], sellerOrgIds: scope.sellerOrgIds },
          random,
        });
      }
      const made = await simulatedCalls([frozen.orgId]);
      expect(made.length).toBeGreaterThanOrEqual(5);
      expect(made.every((call) => call.status === "blocked" && call.simulated)).toBe(true);
      expect(made.every((call) => call.blockReason === "agent_frozen")).toBe(true);
      expect(await balanceOf(db, { type: "wallet", orgId: frozen.orgId })).toBe(0n);
    });

    it("writes nothing when the world has no buyers or no listings", async () => {
      expect(await tick(db, { scope: { buyerOrgIds: [randomUUID()] } })).toBe(0);
      expect(await tick(db, { scope: { sellerOrgIds: [randomUUID()] } })).toBe(0);
    });

    it("honours its limit", async () => {
      const lone = await createInvoicedBuyer(db, 500_000_000n, ["lone"]);
      const loneScope = { buyerOrgIds: [lone.orgId], sellerOrgIds: scope.sellerOrgIds };
      for (let i = 0; i < 10; i++) {
        expect(await tick(db, { scope: loneScope, limit: 1, random: prng(i) })).toBe(1);
      }
      expect(await simulatedCalls([lone.orgId])).toHaveLength(10);
    });

    it("logs and skips a Call that fails", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const failing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") return () => Promise.reject(new Error("boom"));
          return Reflect.get(target, property, receiver);
        },
      });
      expect(await tick(failing, { scope })).toBe(0);
      expect(error).toHaveBeenCalled();
    });
  });

  describe("the loop", () => {
    it("starts and stops, and both are idempotent", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      expect(getSimulationState()).toMatchObject({ running: false, produced: 0, startedAt: null });

      const first = await startSimulation(db, { scope });
      expect(first).toMatchObject({ running: true, ratePerSecond: 3, produced: 0 });
      expect(first.startedAt).toBe(new Date().toISOString());
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(5_000);
      const again = await startSimulation(db, { scope });
      expect(again.startedAt).toBe(first.startedAt);
      expect(vi.getTimerCount()).toBe(1);

      expect(stopSimulation()).toMatchObject({ running: false, stoppedBecause: null });
      expect(vi.getTimerCount()).toBe(0);
      expect(stopSimulation().running).toBe(false);
      expect(stopSimulation()).toEqual(getSimulationState());
    });

    it("writes Calls every second while running and stops writing when stopped", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const before = (await simulatedCalls([acme.orgId])).length;
      await startSimulation(db, { scope });

      vi.advanceTimersByTime(1_000);
      await until(() => getSimulationState().produced >= 1);
      vi.advanceTimersByTime(1_000);
      await until(() => getSimulationState().produced >= 2);

      stopSimulation();
      await realSleep(200);
      const { produced } = getSimulationState();
      const after = await simulatedCalls([acme.orgId]);
      expect(after.length - before).toBe(produced);
      vi.advanceTimersByTime(3_000);
      await realSleep(100);
      expect(getSimulationState().produced).toBe(produced);
      expect((await simulatedCalls([acme.orgId])).length).toBe(after.length);
    });

    it("answers NotSeededError when there is nothing to simulate", async () => {
      await expect(startSimulation(db, { scope: { buyerOrgIds: [randomUUID()] } })).rejects.toThrow(
        NotSeededError,
      );
      expect(getSimulationState().running).toBe(false);
    });

    it("stops itself after its duration", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      expect(SIMULATION_MAX_DURATION_MS).toBe(30 * 60 * 1000);
      await startSimulation(db, { scope });
      vi.setSystemTime(Date.now() + SIMULATION_MAX_DURATION_MS - 1);
      vi.advanceTimersByTime(1_000);
      expect(getSimulationState()).toMatchObject({ running: false, stoppedBecause: "duration" });
      expect(vi.getTimerCount()).toBe(0);
      expect((await startSimulation(db, { scope })).stoppedBecause).toBeNull();
    });

    it("stops itself at the row cap and writes exactly that many rows", async () => {
      expect(SIMULATION_MAX_CALLS).toBe(5_000);
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const capped = await createInvoicedBuyer(db, 500_000_000n, ["capped"]);
      await startSimulation(db, {
        scope: { buyerOrgIds: [capped.orgId], sellerOrgIds: scope.sellerOrgIds },
        maxCalls: 7,
      });
      for (let i = 0; i < 20 && getSimulationState().running; i++) {
        vi.advanceTimersByTime(1_000);
        await realSleep(150);
      }
      expect(getSimulationState()).toMatchObject({
        running: false,
        produced: 7,
        stoppedBecause: "call_cap",
      });
      expect(await simulatedCalls([capped.orgId])).toHaveLength(7);
    });

    it("survives a failing tick and carries on", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let broken = false;
      const flaky = new Proxy(db, {
        get(target, property, receiver) {
          if (broken && property === "select") throw new Error("database went away");
          return Reflect.get(target, property, receiver);
        },
      });
      await startSimulation(flaky, { scope });

      broken = true;
      vi.advanceTimersByTime(1_000);
      await until(() => error.mock.calls.length > 0);
      expect(getSimulationState()).toMatchObject({ running: true, produced: 0 });

      broken = false;
      vi.advanceTimersByTime(1_000);
      await until(() => getSimulationState().produced > 0);
      expect(getSimulationState().running).toBe(true);
    });
  });
});
