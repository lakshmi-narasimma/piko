import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createSeller, stubGatewayEnv } from "@/test/gateway-fixtures";
import { generateCalls, type GeneratedTotals } from "@/test/spend-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, orgs, teams } from "../db/schema";
import { postCall, refundCall } from "../ledger";
import { OrgError, type Actor } from "./index";
import { loadSpendRows, spendRange } from "./spend";

const url = inject("testDatabaseUrl");

describe("spendRange", () => {
  const now = new Date("2026-11-12T15:00:00Z");

  it("defaults to the last 30 days ending today, UTC", () => {
    expect(spendRange({}, now)).toEqual({ from: "2026-10-14", to: "2026-11-12" });
  });

  it("keeps a valid range, swaps a reversed one and ignores junk", () => {
    expect(spendRange({ from: "2026-11-01", to: "2026-11-05" }, now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-05",
    });
    expect(spendRange({ from: "2026-11-05", to: "2026-11-01" }, now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-05",
    });
    expect(spendRange({ from: "2026-02-30", to: ["x"] }, now)).toEqual({
      from: "2026-10-14",
      to: "2026-11-12",
    });
  });
});

describe.skipIf(!url)("spend grid rows", () => {
  let db: Db;
  let acme: Actor;
  let acmeAgents: string[];
  let generated: GeneratedTotals;
  let other: Actor;
  let otherAgent: string;
  let seller: Awaited<ReturnType<typeof createSeller>>;
  const range = spendRange({});

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!);
    // Its own org rather than the Acme seed, which other test files create in parallel.
    const [buyer] = await db
      .insert(orgs)
      .values({
        name: "Spendy",
        slug: `spendy-${randomUUID()}`,
        kind: "company",
        billing: "invoiced",
      })
      .returning({ id: orgs.id });
    const orgId = buyer!.id;
    acme = { org: { id: orgId }, role: "admin" };
    acmeAgents = [];
    for (const [teamName, names] of [
      ["Marketing", ["campaign-researcher", "competitor-watch"]],
      ["Support", ["ticket-triage"]],
      ["Data", ["catalog-sync", "loop-bot"]],
    ] as const) {
      const [team] = await db
        .insert(teams)
        .values({ orgId, name: teamName })
        .returning({ id: teams.id });
      for (const name of names) {
        const [agent] = await db
          .insert(agents)
          .values({ orgId, teamId: team!.id, name })
          .returning({ id: agents.id });
        acmeAgents.push(agent!.id);
      }
    }
    seller = await createSeller(db, "http://localhost/unused", { priceMicro: 2_000n });
    const pricier = await createSeller(db, "http://localhost/unused", { priceMicro: 1_234_567n });

    generated = await generateCalls(db, {
      buyerOrgId: orgId,
      agentIds: acmeAgents,
      endpoints: [
        { id: seller.endpointId, sellerOrgId: seller.orgId, priceMicro: 2_000n },
        { id: pricier.endpointId, sellerOrgId: pricier.orgId, priceMicro: 1_234_567n },
      ],
      count: 12_000,
      days: 25,
    });

    const [org] = await db
      .insert(orgs)
      .values({
        name: "Other",
        slug: `other-${randomUUID()}`,
        kind: "company",
        billing: "invoiced",
      })
      .returning({ id: orgs.id });
    other = { org: { id: org!.id }, role: "admin" };
    const [agent] = await db
      .insert(agents)
      .values({ orgId: org!.id, name: "other-bot" })
      .returning({ id: agents.id });
    otherAgent = agent!.id;
  }, 120_000);
  beforeEach(() => {
    stubGatewayEnv();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  it("returns all 12,000 generated Calls, totals matching the ledger, in well under a second", async () => {
    await loadSpendRows(db, acme, range); // warm the connection and plan
    const started = performance.now();
    const { rows, truncated } = await loadSpendRows(db, acme, range);
    const elapsed = performance.now() - started;

    expect(truncated).toBe(false);
    expect(rows.length).toBe(12_000);
    expect(rows.reduce((sum, row) => sum + row.spentMicro, 0n)).toBe(generated.spentMicro);
    expect(rows.filter((row) => row.simulated).length).toBe(generated.simulatedCalls);
    for (const status of ["paid", "refunded", "free", "blocked"] as const) {
      expect(rows.filter((row) => row.status === status).length).toBe(generated.byStatus[status]);
    }
    expect(rows.filter((row) => row.status !== "paid").every((row) => row.spentMicro === 0n)).toBe(
      true,
    );
    expect(elapsed).toBeLessThan(1_000);
  });

  it("names the team, agent, vendor, listing and endpoint, newest first", async () => {
    const { rows } = await loadSpendRows(db, acme, range);
    expect(new Set(rows.map((row) => row.team))).toEqual(new Set(["Marketing", "Support", "Data"]));
    expect(new Set(rows.map((row) => row.vendor))).toEqual(new Set(["Test Seller"]));
    expect(rows[0]).toMatchObject({ listing: "Test Listing", endpoint: "GET /history" });
    expect(rows[0]!.day).toBe(rows[0]!.at.toISOString().slice(0, 10));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(rows[i]!.at.getTime());
    }
  });

  it("nets a refund to zero and counts a Call made through the real ledger", async () => {
    const insertCall = async (priceMicro: bigint) => {
      const [call] = await db
        .insert(calls)
        .values({
          agentId: otherAgent,
          buyerOrgId: other.org.id,
          endpointId: seller.endpointId,
          amountMicro: priceMicro,
          status: "paid",
        })
        .returning({ id: calls.id });
      await postCall(db, {
        callId: call!.id,
        buyerOrgId: other.org.id,
        sellerOrgId: seller.orgId,
        priceMicro,
      });
      return call!.id;
    };
    const kept = await insertCall(5_000n);
    const refunded = await insertCall(7_000n);
    await refundCall(db, refunded);
    await db.update(calls).set({ status: "refunded" }).where(eq(calls.id, refunded));

    const { rows } = await loadSpendRows(db, other, range);
    const byId = new Map(rows.map((row) => [row.callId, row]));
    expect(byId.get(kept)).toMatchObject({ spentMicro: 5_000n, team: null, agent: "other-bot" });
    expect(byId.get(refunded)).toMatchObject({
      spentMicro: 0n,
      priceMicro: 7_000n,
      status: "refunded",
    });
    expect(rows).toHaveLength(2);
  });

  it("is scoped to the actor's org and the date range", async () => {
    const { rows } = await loadSpendRows(db, acme, range);
    expect(rows.some((row) => row.agent === "other-bot")).toBe(false);

    const before = await loadSpendRows(db, acme, { from: "2000-01-01", to: "2000-01-31" });
    expect(before.rows).toEqual([]);

    const lastWeek = spendRange({
      from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10),
    });
    const recent = await loadSpendRows(db, acme, lastWeek);
    expect(recent.rows.length).toBeGreaterThan(0);
    expect(recent.rows.length).toBeLessThan(12_000);
    expect(recent.rows.every((row) => row.day >= lastWeek.from)).toBe(true);
  });

  it("caps the rows and says so", async () => {
    const { rows, truncated } = await loadSpendRows(db, acme, range, 100);
    expect(rows).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  it("is admin-only", async () => {
    await expect(
      loadSpendRows(db, { org: acme.org, role: "member" }, range),
    ).rejects.toBeInstanceOf(OrgError);
  });
});
