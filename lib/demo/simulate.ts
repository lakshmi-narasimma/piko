/**
 * Live simulated traffic (BACKLOG P9-02, docs/SEED_DATA.md section 6): a background loop
 * that writes 1 to 3 synthetic Calls a second so the dashboards move during the demo.
 *
 * Every Call has `simulated = true`. A paid one goes through postCall, so it gets the same
 * three balanced Ledger entries (buyer wallet, seller, platform) as a real one, in one
 * transaction with its Call row. A refunded or blocked Call has no Ledger entries, as in
 * the pay pipeline. PayPal is never called: this only writes Piko's own tables.
 *
 * The loop lives in this Node process (the app is one long-lived process on Render) and is
 * kept on globalThis so a hot reload doesn't start a second one. It stops itself after
 * SIMULATION_MAX_DURATION_MS or SIMULATION_MAX_CALLS, so it can't fill Neon's free storage.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, calls, endpoints, listings, orgs } from "../db/schema";
import { currentFrozenScope } from "../keys";
import { availableFunds, postCall } from "../ledger";

/** The loop stops itself this long after it started. */
export const SIMULATION_MAX_DURATION_MS = 30 * 60 * 1000;
/** The most Calls one run writes, blocked and refunded ones included. */
export const SIMULATION_MAX_CALLS = 5_000;
/** A tick writes 1 to this many Calls, once a second. */
export const SIMULATION_MAX_PER_TICK = 3;
const TICK_MS = 1_000;
/** Paid Calls only use listings rated at least this; the rest get a policy_denied Call. */
const MIN_PAID_RATING = 3;
/** The gateway's upstream timeout, which a timed-out simulated Call reports as its latency. */
const TIMEOUT_LATENCY_MS = 10_000;

export interface SimulationState {
  running: boolean;
  /** The most Calls a second: a tick writes 1 to this many. */
  ratePerSecond: number;
  /** ISO time the current (or last) run started, or null before the first run. */
  startedAt: string | null;
  /** Calls written by the current run, or by the last one when stopped. */
  produced: number;
  /** Why the last run stopped on its own, or null when it was stopped by a person or is running. */
  stoppedBecause: "duration" | "call_cap" | null;
}

/** The start request found no invoiced buyer agents or no priced listings to call. */
export class NotSeededError extends Error {
  constructor() {
    super("The demo world isn't seeded: run `npm run seed` first.");
    this.name = "NotSeededError";
  }
}

/**
 * Narrows the world to some orgs. The app never passes one; tests do, because they share a
 * database with other test files and must not write Calls against their orgs.
 */
export interface WorldScope {
  buyerOrgIds?: string[];
  sellerOrgIds?: string[];
}

interface World {
  /** The agents of invoiced orgs. */
  buyers: { agentId: string; orgId: string }[];
  /** Priced endpoints rated well enough to be bought. */
  sellable: { id: string; sellerOrgId: string; priceMicro: bigint }[];
  /** Priced endpoints of low-rated listings, which the seeded policies refuse. */
  refused: { id: string; priceMicro: bigint }[];
}

/**
 * The agents of invoiced orgs (never a prepaid wallet such as Sam's, which holds real
 * money) and the priced endpoints of the listings.
 */
async function loadWorld(db: Db, scope: WorldScope = {}): Promise<World> {
  const buyers = await db
    .select({ agentId: agents.id, orgId: agents.orgId })
    .from(agents)
    .innerJoin(orgs, eq(orgs.id, agents.orgId))
    .where(
      and(eq(orgs.billing, "invoiced"), scope.buyerOrgIds && inArray(orgs.id, scope.buyerOrgIds)),
    )
    .orderBy(agents.createdAt, agents.id);
  const priced = await db
    .select({
      id: endpoints.id,
      sellerOrgId: endpoints.sellerOrgId,
      priceMicro: endpoints.priceMicro,
      rating: listings.rating,
    })
    .from(endpoints)
    .innerJoin(listings, eq(listings.id, endpoints.listingId))
    .where(
      and(
        gt(endpoints.priceMicro, 0n),
        scope.sellerOrgIds && inArray(endpoints.sellerOrgId, scope.sellerOrgIds),
      ),
    )
    .orderBy(endpoints.createdAt, endpoints.id);
  const wellRated = (rating: string | null) => rating === null || Number(rating) >= MIN_PAID_RATING;
  return {
    buyers,
    sellable: priced.filter((row) => wellRated(row.rating)),
    refused: priced.filter((row) => !wellRated(row.rating)),
  };
}

const isSeeded = (world: World) => world.buyers.length > 0 && world.sellable.length > 0;

type Random = () => number;
const pick = <T>(items: T[], random: Random): T => items[Math.floor(random() * items.length)]!;

type Outcome =
  | { status: "paid" }
  | { status: "refunded"; upstreamStatus: number | null }
  | { status: "blocked"; blockReason: string };

/** Mostly paid; about 4% refunded after an upstream failure and 3% blocked by a budget. */
function chooseOutcome(random: Random): Outcome {
  const roll = random();
  if (roll < 0.04) {
    return { status: "refunded", upstreamStatus: pick([500, 502, 503, 504, null], random) };
  }
  if (roll < 0.07) return { status: "blocked", blockReason: "budget_exceeded" };
  return { status: "paid" };
}

/** A believable upstream latency: mostly fast, sometimes slow. */
function latencyMs(random: Random): number {
  const base = 60 + Math.floor(random() * 240);
  return random() < 0.1 ? base + 400 + Math.floor(random() * 1_200) : base;
}

/**
 * Writes one simulated Call, in one transaction.
 *
 * A paid Call is written under the buyer org's row lock, after checking its available funds
 * (credit limit plus balance, less holds), so a simulated Call can't push the wallet past
 * its credit limit or race a real payment: if it wouldn't fit, a blocked
 * `insufficient_funds` Call is recorded instead. A frozen agent is blocked too, as it would
 * be for real.
 */
async function writeOne(db: Db, world: World, random: Random): Promise<void> {
  const buyer = pick(world.buyers, random);
  const frozen = (await currentFrozenScope(db, buyer.agentId)) !== null;

  let outcome: Outcome = frozen
    ? { status: "blocked", blockReason: "agent_frozen" }
    : chooseOutcome(random);
  let endpoint: { id: string; sellerOrgId?: string; priceMicro: bigint } = pick(
    world.sellable,
    random,
  );
  if (outcome.status === "paid" && world.refused.length > 0 && random() < 0.03) {
    outcome = { status: "blocked", blockReason: "policy_denied" };
    endpoint = pick(world.refused, random);
  }

  const callId = randomUUID();
  const base = {
    id: callId,
    agentId: buyer.agentId,
    buyerOrgId: buyer.orgId,
    endpointId: endpoint.id,
    amountMicro: endpoint.priceMicro,
    simulated: true,
  };

  await db.transaction(async (tx) => {
    if (outcome.status === "paid") {
      await tx.select().from(orgs).where(eq(orgs.id, buyer.orgId)).for("no key update");
      if ((await availableFunds(tx, buyer.orgId)) < endpoint.priceMicro) {
        await tx
          .insert(calls)
          .values({ ...base, status: "blocked", blockReason: "insufficient_funds", latencyMs: 0 });
        return;
      }
      await tx
        .insert(calls)
        .values({ ...base, status: "paid", upstreamStatus: 200, latencyMs: latencyMs(random) });
      await postCall(tx, {
        callId,
        buyerOrgId: buyer.orgId,
        sellerOrgId: endpoint.sellerOrgId!,
        priceMicro: endpoint.priceMicro,
      });
    } else if (outcome.status === "refunded") {
      await tx.insert(calls).values({
        ...base,
        status: "refunded",
        upstreamStatus: outcome.upstreamStatus,
        latencyMs: outcome.upstreamStatus === null ? TIMEOUT_LATENCY_MS : latencyMs(random),
      });
    } else {
      await tx
        .insert(calls)
        .values({ ...base, status: "blocked", blockReason: outcome.blockReason, latencyMs: 0 });
    }
  });
}

export interface TickOptions {
  scope?: WorldScope;
  random?: Random;
  /** The most Calls this tick may write. */
  limit?: number;
}

/**
 * One tick: writes 1 to 3 simulated Calls, one transaction each, and returns how many it
 * wrote. A Call that fails is logged and skipped, so one bad row can't stop the rest.
 */
export async function tick(db: Db, options: TickOptions = {}): Promise<number> {
  const random = options.random ?? Math.random;
  const world = await loadWorld(db, options.scope);
  if (!isSeeded(world)) return 0;
  const wanted = Math.min(
    1 + Math.floor(random() * SIMULATION_MAX_PER_TICK),
    options.limit ?? SIMULATION_MAX_PER_TICK,
  );
  let written = 0;
  for (let i = 0; i < wanted; i++) {
    try {
      await writeOne(db, world, random);
      written++;
    } catch (error) {
      console.error("simulated call failed", error);
    }
  }
  return written;
}

export interface RunOptions {
  scope?: WorldScope;
  /** Overrides SIMULATION_MAX_CALLS, for tests. */
  maxCalls?: number;
  /** Overrides SIMULATION_MAX_DURATION_MS, for tests. */
  maxDurationMs?: number;
}

interface Run {
  scope?: WorldScope;
  maxCalls: number;
  maxDurationMs: number;
}

interface Engine {
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  running: boolean;
  startedAt: number | null;
  produced: number;
  stoppedBecause: SimulationState["stoppedBecause"];
}

const KEY = Symbol.for("piko.demo.simulation");
type WithEngine = typeof globalThis & { [KEY]?: Engine };

/** The one engine of this process, kept on globalThis so a hot reload reuses it. */
function engine(): Engine {
  const holder = globalThis as WithEngine;
  holder[KEY] ??= {
    timer: null,
    busy: false,
    running: false,
    startedAt: null,
    produced: 0,
    stoppedBecause: null,
  };
  return holder[KEY];
}

export function getSimulationState(): SimulationState {
  const e = engine();
  return {
    running: e.running,
    ratePerSecond: SIMULATION_MAX_PER_TICK,
    startedAt: e.startedAt === null ? null : new Date(e.startedAt).toISOString(),
    produced: e.produced,
    stoppedBecause: e.stoppedBecause,
  };
}

function halt(reason: SimulationState["stoppedBecause"]): void {
  const e = engine();
  if (e.timer) clearInterval(e.timer);
  e.timer = null;
  e.running = false;
  e.stoppedBecause = reason;
}

/** Stops the loop. Stopping a stopped loop does nothing. */
export function stopSimulation(): SimulationState {
  if (engine().running) halt(null);
  return getSimulationState();
}

/**
 * Starts the loop. Starting a running loop does nothing, and keeps its counter.
 *
 * @throws NotSeededError when there are no invoiced buyer agents or no priced listings.
 */
export async function startSimulation(db: Db, options: RunOptions = {}): Promise<SimulationState> {
  const {
    scope,
    maxCalls = SIMULATION_MAX_CALLS,
    maxDurationMs = SIMULATION_MAX_DURATION_MS,
  } = options;
  const e = engine();
  if (e.running) return getSimulationState();
  if (!isSeeded(await loadWorld(db, scope))) throw new NotSeededError();
  // A second start may have won while the world loaded.
  if (e.running) return getSimulationState();

  e.running = true;
  e.startedAt = Date.now();
  e.produced = 0;
  e.stoppedBecause = null;
  e.timer = setInterval(() => void runTick(db, { scope, maxCalls, maxDurationMs }), TICK_MS);
  // The demo traffic never keeps the process alive.
  e.timer.unref?.();
  return getSimulationState();
}

async function runTick(db: Db, run: Run): Promise<void> {
  const e = engine();
  if (!e.running || e.busy) return;
  if (Date.now() - (e.startedAt ?? 0) >= run.maxDurationMs) return halt("duration");
  e.busy = true;
  try {
    e.produced += await tick(db, { scope: run.scope, limit: run.maxCalls - e.produced });
    if (e.running && e.produced >= run.maxCalls) halt("call_cap");
  } catch (error) {
    // Logged, not fatal: the next tick tries again.
    console.error("simulated traffic tick failed", error);
  } finally {
    e.busy = false;
  }
}

/** For tests: stops the loop and forgets its counters. */
export function resetSimulation(): void {
  halt(null);
  const e = engine();
  e.busy = false;
  e.startedAt = null;
  e.produced = 0;
}
