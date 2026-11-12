import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createSeller, stubGatewayEnv } from "@/test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, ledgerEntries, orgs, teams } from "../db/schema";
import { postCall, refundCall } from "../ledger";
import { computeInvoice, currentPeriod, InvoiceError, NO_TEAM_NAME, periodBounds } from "./index";

const url = inject("testDatabaseUrl");

describe("periodBounds", () => {
  it("covers one UTC month, rolling over at year end", () => {
    expect(periodBounds("2026-12")).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
  });

  it("rejects anything that isn't YYYY-MM", () => {
    for (const bad of ["2026-13", "2026-1", "26-01", "2026-00", ""]) {
      expect(() => periodBounds(bad)).toThrow(InvoiceError);
    }
  });
});

describe.skipIf(!url)("computeInvoice", () => {
  let db: Db;
  let seller: { orgId: string; endpointId: string };
  const period = "2026-10";
  const inPeriod = new Date("2026-10-15T12:00:00Z");

  beforeAll(async () => {
    db = createDb(url!);
    stubGatewayEnv();
    seller = await createSeller(db, "http://localhost/unused");
  });
  beforeEach(() => {
    stubGatewayEnv();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  async function newOrg(billing: "invoiced" | "prepaid" = "invoiced") {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Org", slug: `org-${randomUUID()}`, kind: "company", billing })
      .returning({ id: orgs.id });
    return org!.id;
  }

  async function newTeam(orgId: string, name: string) {
    const [team] = await db.insert(teams).values({ orgId, name }).returning({ id: teams.id });
    return team!.id;
  }

  async function newAgent(orgId: string, teamId: string | null) {
    const [agent] = await db
      .insert(agents)
      .values({ orgId, teamId, name: `agent-${randomUUID()}` })
      .returning({ id: agents.id });
    return agent!.id;
  }

  /** A paid Call posted to the Ledger, as the pay pipeline would. */
  async function paidCall(
    orgId: string,
    agentId: string,
    priceMicro: bigint,
    options: { createdAt?: Date; simulated?: boolean } = {},
  ) {
    const [call] = await db
      .insert(calls)
      .values({
        agentId,
        buyerOrgId: orgId,
        endpointId: seller.endpointId,
        amountMicro: priceMicro,
        status: "paid",
        simulated: options.simulated ?? false,
        createdAt: options.createdAt ?? inPeriod,
      })
      .returning({ id: calls.id });
    await postCall(db, {
      callId: call!.id,
      buyerOrgId: orgId,
      sellerOrgId: seller.orgId,
      priceMicro,
    });
    return call!.id;
  }

  /** The org's net wallet debits for Calls in the period, straight from the Ledger. */
  async function ledgerDebits(orgId: string): Promise<bigint> {
    const { from, to } = periodBounds(period);
    const [row] = await db
      .select({ total: sql<string>`coalesce(-sum(${ledgerEntries.amountMicro}), 0)` })
      .from(ledgerEntries)
      .innerJoin(calls, eq(ledgerEntries.refId, sql`${calls.id}::text`))
      .where(
        and(
          eq(ledgerEntries.accountType, "wallet"),
          eq(ledgerEntries.orgId, orgId),
          inArray(ledgerEntries.reason, ["call", "refund"]),
          gte(calls.createdAt, from),
          lt(calls.createdAt, to),
        ),
      );
    return BigInt(row!.total);
  }

  it("bills one line per team, nets refunds, and totals the org's ledger debits", async () => {
    const orgId = await newOrg();
    const support = await newTeam(orgId, "Support");
    const marketing = await newTeam(orgId, "Marketing");
    await newTeam(orgId, "Idle"); // No Calls, so no line.
    const supportAgent = await newAgent(orgId, support);
    const marketingAgent = await newAgent(orgId, marketing);
    const loneAgent = await newAgent(orgId, null);

    await paidCall(orgId, supportAgent, 2_000n);
    await paidCall(orgId, supportAgent, 3_000n, { simulated: true });
    const refunded = await paidCall(orgId, supportAgent, 7_000n);
    await refundCall(db, refunded);
    await paidCall(orgId, marketingAgent, 10_000n);
    await paidCall(orgId, loneAgent, 500n, { simulated: true });

    // Outside the bill: last month, next month, and another org's Calls.
    await paidCall(orgId, marketingAgent, 99_000n, { createdAt: new Date("2026-09-30T23:59:59Z") });
    await paidCall(orgId, marketingAgent, 99_000n, { createdAt: new Date("2026-11-01T00:00:00Z") });
    const otherOrg = await newOrg();
    await paidCall(otherOrg, await newAgent(otherOrg, await newTeam(otherOrg, "Support")), 42_000n);

    const invoice = await computeInvoice(db, orgId, period);

    expect(invoice.lines).toEqual([
      {
        teamId: marketing,
        teamName: "Marketing",
        amountMicro: 10_000n,
        callCount: 1,
        simulatedMicro: 0n,
      },
      {
        teamId: support,
        teamName: "Support",
        amountMicro: 5_000n,
        callCount: 2,
        simulatedMicro: 3_000n,
      },
      {
        teamId: null,
        teamName: NO_TEAM_NAME,
        amountMicro: 500n,
        callCount: 1,
        simulatedMicro: 500n,
      },
    ]);
    expect(invoice.totalMicro).toBe(15_500n);
    expect(invoice.simulatedMicro).toBe(3_500n);
    expect(invoice.totalMicro).toBe(await ledgerDebits(orgId));
    expect(invoice).toMatchObject({
      orgId,
      period,
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
  });

  it("is zero for an invoiced org with no Calls in the period", async () => {
    const orgId = await newOrg();
    const invoice = await computeInvoice(db, orgId, period);
    expect(invoice.lines).toEqual([]);
    expect(invoice.totalMicro).toBe(0n);
    expect(invoice.totalMicro).toBe(await ledgerDebits(orgId));
  });

  it("refuses prepaid and unknown orgs", async () => {
    await expect(computeInvoice(db, await newOrg("prepaid"), period)).rejects.toMatchObject({
      code: "not_invoiced",
    });
    await expect(computeInvoice(db, randomUUID(), period)).rejects.toMatchObject({
      code: "org_not_found",
    });
  });

  it("knows the current period from the database clock", async () => {
    expect(await currentPeriod(db)).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});
