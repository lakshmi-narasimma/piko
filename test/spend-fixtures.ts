/**
 * A bulk test set of Calls for the spend grid (BACKLOG P5-09): thousands of Calls with their
 * Ledger entries, written in batches instead of through the pay pipeline so 12,000 take
 * seconds. For tests and local load checks only; never point it at Neon.
 *
 * Each paid Call gets the three entries postCall writes (buyer wallet, seller, platform),
 * and each refunded one also gets the three reversing entries refundCall writes. Free and
 * blocked Calls get none, as in the pay pipeline.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../lib/db/client";
import { calls, ledgerEntries } from "../lib/db/schema";
import { splitPrice } from "../lib/money";

export interface GeneratedEndpoint {
  id: string;
  sellerOrgId: string;
  priceMicro: bigint;
}

export interface GenerateCallsInput {
  buyerOrgId: string;
  agentIds: string[];
  endpoints: GeneratedEndpoint[];
  count: number;
  /** Calls are spread evenly over this many days ending at `now`. */
  days: number;
  now?: Date;
  /** Fraction of Calls marked simulated. Defaults to 0.5. */
  simulatedShare?: number;
  feeBps?: bigint;
  /** Seeds the pseudo-random choices, so a run is repeatable. */
  seed?: number;
}

export interface GeneratedTotals {
  calls: number;
  /** Net wallet spend over every generated Call. */
  spentMicro: bigint;
  simulatedCalls: number;
  byStatus: Record<"paid" | "refunded" | "free" | "blocked", number>;
}

const BATCH = 1_000;

/** A small seeded PRNG (mulberry32), so tests don't depend on Math.random. */
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

export async function generateCalls(db: Db, input: GenerateCallsInput): Promise<GeneratedTotals> {
  const now = (input.now ?? new Date()).getTime();
  const span = input.days * 86_400_000;
  const feeBps = input.feeBps ?? 500n;
  const simulatedShare = input.simulatedShare ?? 0.5;
  const random = prng(input.seed ?? 1);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const totals: GeneratedTotals = {
    calls: 0,
    spentMicro: 0n,
    simulatedCalls: 0,
    byStatus: { paid: 0, refunded: 0, free: 0, blocked: 0 },
  };

  for (let start = 0; start < input.count; start += BATCH) {
    const size = Math.min(BATCH, input.count - start);
    const callRows: (typeof calls.$inferInsert)[] = [];
    const entryRows: (typeof ledgerEntries.$inferInsert)[] = [];

    for (let i = 0; i < size; i++) {
      const n = start + i;
      const endpoint = pick(input.endpoints);
      const roll = random();
      const status =
        roll < 0.85 ? "paid" : roll < 0.9 ? "refunded" : roll < 0.95 ? "free" : "blocked";
      const simulated = random() < simulatedShare;
      const createdAt = new Date(now - Math.floor((n / input.count) * span) - 1);
      const id = randomUUID();
      const priceMicro = status === "free" ? 0n : endpoint.priceMicro;
      callRows.push({
        id,
        agentId: pick(input.agentIds),
        buyerOrgId: input.buyerOrgId,
        endpointId: endpoint.id,
        amountMicro: priceMicro,
        status,
        blockReason: status === "blocked" ? "budget_exceeded" : null,
        simulated,
        createdAt,
      });

      if (status === "paid" || status === "refunded") {
        const { sellerMicro, platformMicro } = splitPrice(priceMicro, feeBps);
        const post = (reason: "call" | "refund", sign: bigint) => {
          const txnId = randomUUID();
          const common = { txnId, reason, refId: id, createdAt } as const;
          entryRows.push(
            {
              ...common,
              accountType: "wallet",
              orgId: input.buyerOrgId,
              amountMicro: -priceMicro * sign,
            },
            {
              ...common,
              accountType: "seller",
              orgId: endpoint.sellerOrgId,
              amountMicro: sellerMicro * sign,
            },
            { ...common, accountType: "platform", orgId: null, amountMicro: platformMicro * sign },
          );
        };
        post("call", 1n);
        if (status === "refunded") post("refund", -1n);
        else totals.spentMicro += priceMicro;
      }
      totals.calls++;
      totals.byStatus[status]++;
      if (simulated) totals.simulatedCalls++;
    }

    await db.transaction(async (tx) => {
      await tx.insert(calls).values(callRows);
      if (entryRows.length > 0) await tx.insert(ledgerEntries).values(entryRows);
    });
  }
  // A bulk load this size leaves the planner without statistics until autovacuum next runs,
  // and with none it plans the spend query as if each org had one Call. Production tables
  // are analyzed continuously, so do what autovacuum would.
  await db.execute(sql`analyze calls, ledger_entries`);
  return totals;
}
