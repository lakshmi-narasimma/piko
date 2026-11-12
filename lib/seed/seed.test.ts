import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  accounts,
  agents,
  alerts,
  apiKeys,
  budgets,
  calls,
  endpoints,
  ledgerEntries,
  listings,
  memberships,
  orgs,
  policies,
  rateOverrides,
  teams,
} from "../db/schema";
import { findPersona, PERSONAS } from "../auth/accounts";
import { authenticateKey } from "../keys";
import { balanceOf } from "../ledger";
import { loadOrgTree } from "../org";
import { loadSpendRows, spendRange } from "../org/spend";
import { loadPolicies, parsePolicyDocument } from "../policy";
import {
  ACME_CREDIT_LIMIT_MICRO,
  DATACORP_SEED_BALANCE_MICRO,
  DEFAULT_HISTORY_CALLS,
  PRIYA_SEED_BALANCE_MICRO,
  seed,
} from "./index";

const url = inject("testDatabaseUrl");

// Seeding truncates every table and test files share one database, so this file gets its own.
describe.skipIf(!url)("seed", () => {
  const databaseName = `piko_seed_${randomUUID().replaceAll("-", "")}`;
  const appBaseUrl = "http://localhost:3000";
  let db: Db;

  async function admin(statement: string) {
    const client = new Client({ connectionString: url! });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  /** Every seeded row's business fields, without generated ids, timestamps or key material. */
  async function snapshot() {
    const orgRows = await db.select().from(orgs).orderBy(asc(orgs.slug));
    const orgSlug = new Map(orgRows.map((org) => [org.id, org.slug]));
    const listingRows = await db.select().from(listings).orderBy(asc(listings.slug));
    const listingSlug = new Map(listingRows.map((row) => [row.id, row.slug]));
    const endpointRows = await db.select().from(endpoints);
    const teamRows = await db.select().from(teams);
    const teamName = new Map(teamRows.map((team) => [team.id, team.name]));
    return {
      orgs: orgRows.map(({ name, slug, kind, billing, creditLimitMicro }) => ({
        name,
        slug,
        kind,
        billing,
        creditLimitMicro,
      })),
      accounts: (await db.select().from(accounts).orderBy(asc(accounts.email))).map(
        ({ email, name }) => ({ email, name }),
      ),
      memberships: (await db.select().from(memberships))
        .map(({ orgId, role }) => ({ org: orgSlug.get(orgId), role }))
        .sort((a, b) => a.org!.localeCompare(b.org!)),
      agents: (await db.select().from(agents)).map(({ orgId, name, teamId }) => ({
        org: orgSlug.get(orgId),
        name,
        team: teamId && teamName.get(teamId),
      })),
      teams: teamRows.map(({ orgId, name }) => ({ org: orgSlug.get(orgId), name })),
      listings: listingRows.map(({ sellerOrgId, slug, name, baseUrl, kind, category, rating }) => ({
        seller: orgSlug.get(sellerOrgId),
        slug,
        name,
        baseUrl,
        kind,
        category,
        rating,
      })),
      endpoints: endpointRows
        .map(({ listingId, method, pathOrTool, priceMicro, freeQuota }) => ({
          listing: listingSlug.get(listingId),
          method,
          pathOrTool,
          priceMicro,
          freeQuota,
        }))
        .sort((a, b) => a.listing!.localeCompare(b.listing!)),
      ledger: (await db.select().from(ledgerEntries))
        .map(({ accountType, orgId, amountMicro, reason, refId }) => ({
          accountType,
          org: orgId && orgSlug.get(orgId),
          amountMicro,
          reason,
          refId,
        }))
        .sort((a, b) =>
          `${a.refId}|${a.accountType}|${a.reason}`.localeCompare(
            `${b.refId}|${b.accountType}|${b.reason}`,
          ),
        ),
      keyCount: (await db.select().from(apiKeys)).length,
    };
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(url!);
    databaseUrl.pathname = `/${databaseName}`;
    await runMigrations(databaseUrl.toString());
    db = createDb(databaseUrl.toString(), { max: 2 });
  });

  afterAll(async () => {
    await db?.$client.end();
    await admin(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  it("creates the minimal demo world", async () => {
    const { samKey } = await seed(db, { appBaseUrl, historyCalls: 0 });
    const state = await snapshot();

    const named = state.orgs.filter((org) => !org.slug.startsWith("buyer-"));
    expect(named.map((org) => org.slug)).toEqual(["acme", "datacorp", "priya", "sam"]);
    expect(state.orgs).toHaveLength(24);
    expect(state.agents.filter((agent) => agent.org === "sam")).toEqual([
      { org: "sam", name: "shopping-assistant", team: null },
    ]);
    expect(state.keyCount).toBe(1);
    expect(state.listings.map(({ slug, seller }) => [slug, seller])).toEqual([
      ["cheap-reviews", "datacorp"],
      ["price-history", "priya"],
      ["product-search", "datacorp"],
      ["review-summariser", "priya"],
    ]);
    expect(state.listings[1]!.baseUrl).toBe("http://localhost:3000/api/demo/sellers/price-history");
    expect(state.endpoints).toEqual([
      {
        listing: "cheap-reviews",
        method: "POST",
        pathOrTool: "/summarise",
        priceMicro: 3_000n,
        freeQuota: 0,
      },
      {
        listing: "price-history",
        method: "GET",
        pathOrTool: "/history",
        priceMicro: 2_000n,
        freeQuota: 0,
      },
      {
        listing: "product-search",
        method: "GET",
        pathOrTool: "/search",
        priceMicro: 10_000n,
        freeQuota: 5,
      },
      {
        listing: "review-summariser",
        method: "POST",
        pathOrTool: "/summarise",
        priceMicro: 5_000n,
        freeQuota: 0,
      },
    ]);

    expect((await authenticateKey(db, samKey)).ok).toBe(true);

    const [priya] = await db.select().from(orgs).where(eq(orgs.slug, "priya"));
    expect(await balanceOf(db, { type: "seller", orgId: priya!.id })).toBe(
      PRIYA_SEED_BALANCE_MICRO,
    );
    expect(PRIYA_SEED_BALANCE_MICRO).toBe(940_000n);

    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: sam!.id })).toBe(0n);
  });

  it("temporarily seeds Dana's Acme Corp with its 3 teams and 5 agents (until P9-01)", async () => {
    await seed(db, { appBaseUrl, historyCalls: 0 });
    const state = await snapshot();

    expect(state.orgs.find((org) => org.slug === "acme")).toMatchObject({
      name: "Acme Corp",
      kind: "company",
      billing: "invoiced",
      creditLimitMicro: 500_000_000n,
    });
    expect(state.memberships).toContainEqual({ org: "acme", role: "admin" });
    expect(state.teams.filter((team) => team.org === "acme").map((team) => team.name)).toEqual([
      "Marketing",
      "Support",
      "Data",
    ]);
    expect(
      state.agents
        .filter((agent) => agent.org === "acme")
        .map(({ name, team }) => [name, team])
        .sort(),
    ).toEqual([
      ["campaign-researcher", "Marketing"],
      ["catalog-sync", "Data"],
      ["competitor-watch", "Marketing"],
      ["loop-bot", "Data"],
      ["ticket-triage", "Support"],
    ]);

    const danaTemp = await findPersona(db, "dana@acme.demo");
    expect(danaTemp).toMatchObject({ org: { slug: "acme" }, role: "admin", area: "org" });
  });

  it("creates Dana as admin of Acme Corp, an invoiced company with a $500 credit limit", async () => {
    await seed(db, { appBaseUrl, historyCalls: 0 });
    const state = await snapshot();

    expect(state.orgs.find((org) => org.slug === "acme")).toMatchObject({
      name: "Acme Corp",
      slug: "acme",
      kind: "company",
      billing: "invoiced",
      creditLimitMicro: ACME_CREDIT_LIMIT_MICRO,
    });
    expect(ACME_CREDIT_LIMIT_MICRO).toBe(500_000_000n);
    expect(state.accounts).toContainEqual({ email: "dana@acme.demo", name: "Dana" });
    expect(state.memberships).toContainEqual({ org: "acme", role: "admin" });

    const dana = await findPersona(db, "dana@acme.demo");
    expect(dana).toMatchObject({ org: { slug: "acme" }, role: "admin", area: "org" });
  });

  it("gives every persona on the switcher an account to log in as", async () => {
    await seed(db, { appBaseUrl, historyCalls: 0 });
    const areas = await Promise.all(
      PERSONAS.map(async ({ email }) => [email, (await findPersona(db, email))?.area]),
    );
    expect(areas).toEqual([
      ["sam@demo.piko", "wallet"],
      ["dana@acme.demo", "org"],
      ["priya@demo.piko", "seller"],
      ["omar@datacorp.demo", "seller"],
    ]);
  });

  it("leaves the same state when run twice, and invalidates the earlier key", async () => {
    const first = await seed(db, { appBaseUrl, historyCalls: 2_000 });
    const before = await snapshot();
    const second = await seed(db, { appBaseUrl, historyCalls: 2_000 });
    const after = await snapshot();

    expect(after).toEqual(before);
    expect((await authenticateKey(db, first.samKey)).ok).toBe(false);
    expect((await authenticateKey(db, second.samKey)).ok).toBe(true);
  });

  it("can start Sam's wallet funded, for running paid Calls before top-ups exist", async () => {
    await seed(db, { appBaseUrl, historyCalls: 0, samWalletMicro: 5_000_000n });
    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: sam!.id })).toBe(5_000_000n);
  });

  it("clears rows the Ledger's trigger would refuse to delete", async () => {
    await seed(db, { appBaseUrl, historyCalls: 0 });
    const [sam] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId: sam!.id,
      amountMicro: 5_000_000n,
      reason: "seed",
      refId: randomUUID(),
    });

    await seed(db, { appBaseUrl, historyCalls: 0 });

    const [samAfter] = await db.select().from(orgs).where(eq(orgs.slug, "sam"));
    expect(await balanceOf(db, { type: "wallet", orgId: samAfter!.id })).toBe(0n);
  });

  it("uses the exact app base URL for every listing, with no localhost fallback", async () => {
    const remoteBaseUrl = "https://piko-demo.onrender.com";
    await seed(db, { appBaseUrl: remoteBaseUrl, historyCalls: 0 });
    const rows = await db.select({ slug: listings.slug, baseUrl: listings.baseUrl }).from(listings);
    expect(rows).toHaveLength(4);
    for (const { slug, baseUrl } of rows) {
      expect(baseUrl).toBe(`https://piko-demo.onrender.com/api/demo/sellers/${slug}`);
    }
  });

  it("stores the sellers' PayPal emails: the given ones, else an undeliverable placeholder", async () => {
    await seed(db, {
      appBaseUrl,
      historyCalls: 0,
      sellerPaypalEmails: { priya: "priya-seller@personal.example.com" },
    });
    const emails = Object.fromEntries(
      (await db.select().from(orgs)).map((org) => [org.slug, org.paypalEmail]),
    );
    expect(emails.priya).toBe("priya-seller@personal.example.com");
    expect(emails.datacorp).toMatch(/@sandbox\.invalid$/);
  });

  describe("the full world with the default 12,000 simulated Calls", { timeout: 30_000 }, () => {
    const now = new Date();
    let seedMs = 0;

    /** The Org tree as the console shows it: names, budgets and totals, not generated ids. */
    function withoutIds(tree: Awaited<ReturnType<typeof loadOrgTree>>) {
      const node = ({
        name,
        spentMicro,
        simulatedMicro,
        budgets,
      }: (typeof tree.teams)[number]) => ({
        name,
        spentMicro,
        simulatedMicro,
        budgets,
      });
      return {
        spentMicro: tree.spentMicro,
        simulatedMicro: tree.simulatedMicro,
        budgets: tree.budgets,
        teams: tree.teams.map((team) => ({
          ...node(team),
          agents: team.agents.map((agent) => node({ ...agent, agents: [], id: "", frozen: false })),
        })),
        unassigned: tree.unassigned.map((agent) => agent.name),
      };
    }

    /** What the dashboards show: spend grid rows, the Org tree, balances and counts. */
    async function dashboards() {
      const [acme] = await db.select().from(orgs).where(eq(orgs.slug, "acme"));
      const actor = { org: { id: acme!.id }, role: "admin" as const };
      const orgRows = await db.select().from(orgs).orderBy(asc(orgs.slug));
      return {
        grid: (await loadSpendRows(db, actor, spendRange({}, now))).rows,
        tree: withoutIds(await loadOrgTree(db, acme!.id)),
        wallets: await Promise.all(
          orgRows.map(async (org) => [
            org.slug,
            await balanceOf(db, { type: "wallet", orgId: org.id }),
            await balanceOf(db, { type: "seller", orgId: org.id }),
          ]),
        ),
        platform: await balanceOf(db, { type: "platform" }),
        statuses: (
          await db.execute<{ status: string; n: string }>(
            sql`select status, count(*)::text as n from calls group by status order by status`,
          )
        ).rows,
      };
    }

    beforeAll(async () => {
      const started = Date.now();
      await seed(db, { appBaseUrl, now });
      seedMs = Date.now() - started;
    }, 60_000);

    const one = async (query: ReturnType<typeof sql>) =>
      (await db.execute<Record<string, string>>(query)).rows[0]!;

    it("creates the doc's counts, and finishes quickly", async () => {
      expect(DEFAULT_HISTORY_CALLS).toBe(12_000);
      expect((await db.select().from(calls)).length).toBe(12_000);
      // Sam, Acme, Priya Labs, DataCorp and 20 synthetic buyers.
      expect((await db.select().from(orgs)).length).toBe(24);
      expect((await db.select().from(teams)).length).toBe(3);
      expect((await db.select().from(listings)).length).toBe(4);
      expect((await db.select().from(policies)).length).toBe(2);
      // $1.00 task budget on Sam's agent, plus Acme's org, 3 team and the search budgets.
      const budgetRows = await db.select().from(budgets);
      expect(budgetRows.filter((b) => b.period === "task").map((b) => b.maxMicro)).toEqual([
        1_000_000n,
      ]);
      expect(budgetRows).toHaveLength(6);
      expect((await db.select().from(rateOverrides))[0]!.priceMicro).toBe(7_000n);
      const [sam] = await db.select().from(agents).where(eq(agents.name, "shopping-assistant"));
      expect(sam!.notifyAboveMicro).toBe(50_000n);
      console.log(`seed of ${DEFAULT_HISTORY_CALLS} Calls took ${seedMs} ms`);
      expect(seedMs).toBeLessThan(15_000);
    });

    it("flags every Call simulated, with no exceptions", async () => {
      const row = await one(
        sql`select count(*) filter (where not simulated)::text as real_calls from calls`,
      );
      expect(row.real_calls).toBe("0");
    });

    it("gives each paid Call three entries that sum to zero, and no other Call any", async () => {
      const grouped = (
        await db.execute<{ n: string; total: string }>(
          sql`select count(*)::text as n, sum(amount_micro)::text as total
              from ledger_entries where reason = 'call' group by ref_id`,
        )
      ).rows;
      const paid = await one(sql`select count(*)::text as n from calls where status = 'paid'`);
      expect(grouped).toHaveLength(Number(paid.n));
      expect(grouped.every((g) => g.n === "3" && g.total === "0")).toBe(true);

      const stray = await one(sql`select count(*)::text as n from ledger_entries
        where reason = 'call' and ref_id in (select id::text from calls where status <> 'paid')`);
      expect(stray.n).toBe("0");

      const byStatus = Object.fromEntries(
        (await dashboards()).statuses.map((row) => [row.status, Number(row.n)]),
      );
      expect(byStatus.refunded).toBeGreaterThan(60);
      expect(byStatus.refunded).toBeLessThan(250);
      expect(byStatus.blocked).toBe(10);
      expect(byStatus.free).toBeGreaterThan(0);
      const blocked = await db.select().from(calls).where(eq(calls.status, "blocked"));
      expect(blocked.every((call) => call.blockReason !== null)).toBe(true);
      expect(new Set(blocked.map((call) => call.blockReason))).toEqual(
        new Set(["policy_denied", "budget_exceeded"]),
      );
      // One breaker trip plus one alert per blocked Call.
      expect((await db.select().from(alerts)).length).toBe(11);
    });

    it("balances the Ledger: everything but seed funding sums to zero", async () => {
      const other = await one(
        sql`select coalesce(sum(amount_micro), 0)::text as total from ledger_entries where reason <> 'seed'`,
      );
      expect(other.total).toBe("0");
    });

    it("never overdraws a prepaid wallet, and keeps Acme within its credit limit", async () => {
      for (const org of await db.select().from(orgs)) {
        const wallet = await balanceOf(db, { type: "wallet", orgId: org.id });
        if (org.billing === "prepaid") expect(wallet, org.slug).toBeGreaterThanOrEqual(0n);
        else expect(wallet + org.creditLimitMicro, org.slug).toBeGreaterThanOrEqual(0n);
      }
    });

    it("leaves Priya at $0.94 and DataCorp at $12.40", async () => {
      const bySlug = Object.fromEntries((await db.select().from(orgs)).map((o) => [o.slug, o.id]));
      expect(await balanceOf(db, { type: "seller", orgId: bySlug.priya! })).toBe(
        PRIYA_SEED_BALANCE_MICRO,
      );
      expect(await balanceOf(db, { type: "seller", orgId: bySlug.datacorp! })).toBe(
        DATACORP_SEED_BALANCE_MICRO,
      );
      expect(DATACORP_SEED_BALANCE_MICRO).toBe(12_400_000n);
    });

    it("seeds the vendor-block policy and no approval_above policy, and every policy loads", async () => {
      const rows = await db.select().from(policies);
      const rules = rows.flatMap((row) => parsePolicyDocument(row.compiledJson).rules);
      expect(rules.some((rule) => rule.type === "vendor_block")).toBe(true);
      expect(rules.some((rule) => rule.type === "approval_above")).toBe(false);
      expect(rows.every((row) => row.confirmedAt !== null)).toBe(true);

      // One unreadable document would fail every payment in its org.
      for (const org of await db.select().from(orgs)) {
        await expect(loadPolicies(db, org.id)).resolves.toBeDefined();
      }
      const [acme] = await db.select().from(orgs).where(eq(orgs.slug, "acme"));
      const loaded = await loadPolicies(db, acme!.id);
      expect(loaded).toHaveLength(2);
      const block = loaded.find((p) => p.document.rules.some((r) => r.type === "vendor_block"))!;
      expect(block.document.scope).toEqual({ org: true });
    });

    it("shows the simulated Calls in Acme's spend grid, at the enterprise rate", async () => {
      const [acme] = await db.select().from(orgs).where(eq(orgs.slug, "acme"));
      const { rows, truncated } = await loadSpendRows(
        db,
        { org: { id: acme!.id }, role: "admin" },
        spendRange({}, now),
      );
      const acmeCalls = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.buyerOrgId, acme!.id)));
      expect(truncated).toBe(false);
      expect(rows).toHaveLength(acmeCalls.length);
      expect(rows.length).toBeGreaterThan(6_000);
      expect(rows.every((row) => row.simulated)).toBe(true);
      expect(new Set(rows.map((row) => row.team))).toEqual(
        new Set(["Marketing", "Support", "Data"]),
      );
      const searchPrices = rows
        .filter((row) => row.listing === "Product Search" && row.status === "paid")
        .map((row) => row.priceMicro);
      expect(new Set(searchPrices)).toEqual(new Set([7_000n]));
      expect(rows.some((row) => row.agent === "loop-bot")).toBe(true);
      const spent = rows.reduce((sum, row) => sum + row.spentMicro, 0n);
      expect(spent).toBeGreaterThan(0n);
      expect(-(await balanceOf(db, { type: "wallet", orgId: acme!.id }))).toBe(spent);
    });

    it("gives identical dashboards when run twice on the same day", async () => {
      const before = await dashboards();
      await seed(db, { appBaseUrl, now });
      const after = await dashboards();
      expect(after).toEqual(before);
      expect(after.grid.length).toBeGreaterThan(0);
    }, 60_000);
  });
});
