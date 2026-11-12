/**
 * Simulated Call history for the demo world (docs/SEED_DATA.md section 5). Everything here is
 * deterministic: a fixed-seed PRNG, and timestamps anchored to a UTC midnight, so seeding twice
 * on the same day gives identical dashboards. Every Call is `simulated = true`.
 *
 * A paid Call has the same three balanced Ledger entries as a live one (buyer wallet, seller,
 * platform fee via `splitPrice`). Free, refunded and blocked Calls have none: a refund releases
 * its reservation before anything is posted (BACKLOG P8-01).
 */
import { splitPrice } from "../money";

export const DAY_MS = 86_400_000;
/** Completed UTC days the history covers, ending yesterday, so every Call is in the past. */
export const HISTORY_DAYS = 29;
export const DEFAULT_HISTORY_CALLS = 12_000;
const PRNG_SEED = 0x9140_0001;

/** mulberry32: a small, fast PRNG whose sequence depends only on its seed. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export interface HistoryEndpoint {
  slug: string;
  endpointId: string;
  sellerOrgId: string;
  /** The list price. */
  priceMicro: bigint;
  freeQuota: number;
}

export interface HistoryAgent {
  agentId: string;
  orgId: string;
  name: string;
  /** Weight among its group's agents. */
  weight: number;
  /** Relative use of each endpoint slug. */
  mix: Readonly<Record<string, number>>;
  /** Acme's agents get its enterprise rates; the rest pay list price. */
  acme: boolean;
}

export interface HistoryPlan {
  calls: number;
  /** UTC midnight of today: every timestamp is a fixed offset before it. */
  anchor: Date;
  feeBps: bigint;
  endpoints: readonly HistoryEndpoint[];
  /** Acme's price per endpoint slug, where it differs from the list price. */
  acmePrices: Readonly<Record<string, bigint>>;
  acmeAgents: readonly HistoryAgent[];
  externalAgents: readonly HistoryAgent[];
  /** Share of Calls from Acme's agents; the rest come from the external buyer orgs. */
  acmeShare: number;
}

export interface CallRow {
  id: string;
  agentId: string;
  buyerOrgId: string;
  endpointId: string;
  amountMicro: bigint;
  status: "paid" | "free" | "refunded" | "blocked";
  blockReason: string | null;
  upstreamStatus: number | null;
  latencyMs: number | null;
  simulated: true;
  createdAt: Date;
}

export interface LedgerRow {
  txnId: string;
  accountType: "wallet" | "seller" | "platform";
  orgId: string | null;
  amountMicro: bigint;
  reason: "call";
  refId: string;
  createdAt: Date;
}

export interface GeneratedHistory {
  calls: CallRow[];
  entries: LedgerRow[];
}

function uuid(rng: () => number): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) bytes.writeUInt32BE(Math.floor(rng() * 2 ** 32), i * 4);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A weighted pick; entries with weight 0 are never chosen. */
function pick<T>(rng: () => number, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll < 0) return item;
  }
  return items.findLast((item) => weight(item) > 0)!;
}

/** A timestamp in one of the history days: weekday peaks, quiet weekends, a daytime bell. */
function makeTimestamp(rng: () => number, anchor: Date, dayWeights: readonly number[]): Date {
  const offsets = dayWeights.map((_, i) => i + 1);
  const daysBack = pick(rng, offsets, (offset) => dayWeights[offset - 1]!);
  const hour = pick(
    rng,
    Array.from({ length: 24 }, (_, h) => h),
    (h) => Math.exp(-(((h - 14) / 5) ** 2)) + 0.05,
  );
  return new Date(anchor.getTime() - daysBack * DAY_MS + hour * 3_600_000 + rng() * 3_599_000);
}

const REFUND_RATE = 0.01;
const POLICY_DENIED_CALLS = 6;
const BUDGET_EXCEEDED_CALLS = 4;

/** Generates `plan.calls` Calls (every status) and the Ledger entries of the paid ones. */
export function generateHistory(plan: HistoryPlan): GeneratedHistory {
  const rng = createRng(PRNG_SEED);
  const bySlug = new Map(plan.endpoints.map((endpoint) => [endpoint.slug, endpoint]));

  const dayWeights = Array.from({ length: HISTORY_DAYS }, (_, i) => {
    const day = new Date(plan.anchor.getTime() - (i + 1) * DAY_MS).getUTCDay();
    return (day === 0 || day === 6 ? 0.35 : 1) * (0.8 + rng() * 0.4);
  });

  interface Draft {
    agent: HistoryAgent;
    endpoint: HistoryEndpoint;
    at: Date;
    blocked: string | null;
  }
  const drafts: Draft[] = [];

  const specialBlocked = plan.calls >= 100 ? POLICY_DENIED_CALLS + BUDGET_EXCEEDED_CALLS : 0;
  for (let i = 0; i < specialBlocked; i++) {
    const denied = i < POLICY_DENIED_CALLS;
    // Policy denials: an Acme agent asks for Cheap Reviews, which Acme's vendor-block policy
    // forbids. Budget hits: Marketing's search agent past its monthly search budget.
    const agent = denied
      ? pick(rng, plan.acmeAgents, (a) => a.weight)
      : plan.acmeAgents.find((a) => a.name === "campaign-researcher")!;
    drafts.push({
      agent,
      endpoint: bySlug.get(denied ? "cheap-reviews" : "product-search")!,
      at: makeTimestamp(rng, plan.anchor, dayWeights),
      blocked: denied ? "policy_denied" : "budget_exceeded",
    });
  }

  while (drafts.length < plan.calls) {
    const group = rng() < plan.acmeShare ? plan.acmeAgents : plan.externalAgents;
    const agent = pick(rng, group, (a) => a.weight);
    const endpoint = bySlug.get(pick(rng, Object.keys(agent.mix), (slug) => agent.mix[slug]!))!;
    drafts.push({
      agent,
      endpoint,
      at: makeTimestamp(rng, plan.anchor, dayWeights),
      blocked: null,
    });
  }
  drafts.sort((a, b) => a.at.getTime() - b.at.getTime());

  const calls: CallRow[] = [];
  const entries: LedgerRow[] = [];
  const freeUsed = new Map<string, number>();

  for (const { agent, endpoint, at, blocked } of drafts) {
    const id = uuid(rng);
    const price = agent.acme
      ? (plan.acmePrices[endpoint.slug] ?? endpoint.priceMicro)
      : endpoint.priceMicro;
    const base = {
      id,
      agentId: agent.agentId,
      buyerOrgId: agent.orgId,
      endpointId: endpoint.endpointId,
      simulated: true as const,
      createdAt: at,
    };

    if (blocked) {
      calls.push({
        ...base,
        amountMicro: price,
        status: "blocked",
        blockReason: blocked,
        upstreamStatus: null,
        latencyMs: null,
      });
      continue;
    }

    const freeKey = `${agent.orgId}:${endpoint.endpointId}`;
    if ((freeUsed.get(freeKey) ?? 0) < endpoint.freeQuota) {
      freeUsed.set(freeKey, (freeUsed.get(freeKey) ?? 0) + 1);
      calls.push({
        ...base,
        amountMicro: 0n,
        status: "free",
        blockReason: null,
        upstreamStatus: 200,
        latencyMs: 60 + Math.floor(rng() * 400),
      });
      continue;
    }

    if (rng() < REFUND_RATE) {
      calls.push({
        ...base,
        amountMicro: price,
        status: "refunded",
        blockReason: null,
        upstreamStatus: pick(rng, [502, 503, 504], () => 1),
        latencyMs: 300 + Math.floor(rng() * 4_000),
      });
      continue;
    }

    calls.push({
      ...base,
      amountMicro: price,
      status: "paid",
      blockReason: null,
      // A 4xx stays paid (BACKLOG P8-01).
      upstreamStatus: rng() < 0.02 ? 422 : 200,
      latencyMs: 80 + Math.floor(rng() * 900),
    });
    const { sellerMicro, platformMicro } = splitPrice(price, plan.feeBps);
    const txnId = uuid(rng);
    const common = { txnId, reason: "call" as const, refId: id, createdAt: at };
    entries.push(
      { ...common, accountType: "wallet", orgId: agent.orgId, amountMicro: -price },
      { ...common, accountType: "seller", orgId: endpoint.sellerOrgId, amountMicro: sellerMicro },
      { ...common, accountType: "platform", orgId: null, amountMicro: platformMicro },
    );
  }

  return { calls, entries };
}
