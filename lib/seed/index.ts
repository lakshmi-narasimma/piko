/**
 * The full demo world (BACKLOG P1-07 and P9-01, docs/SEED_DATA.md). Seeding resets the database
 * first, so running it twice leaves the same state. It wipes every table: only run it against
 * a demo or test database.
 *
 * Left out on purpose (see docs/BACKLOG.md P9-01): the `approval_above` half of Acme's first
 * Policy, because approvals (P5-04) aren't built and a matching `approval_above` denies the
 * Call; and the "$183 this month" total for Acme, which 12,000 Calls at these prices can't
 * reach. The live generator is P9-02 and the demo product is the checkout flow.
 */
import { eq, sql } from "drizzle-orm";
import { BREAKER_TRIPPED, BUDGET_ALERT_TYPE, POLICY_ALERT_TYPE } from "../alerts/types";
import { createBudget } from "../budgets";
import type { Db } from "../db/client";
import {
  accounts,
  agents,
  alerts,
  endpoints,
  ledgerEntries,
  listings,
  memberships,
  orgs,
  policies,
  rateOverrides,
  teams,
} from "../db/schema";
import { createKey } from "../keys";
import { parsePolicyDocument, policyDocumentToJson } from "../policy/schema";
import { seedAcmeTemp } from "./acme-temp";
import {
  DAY_MS,
  DEFAULT_HISTORY_CALLS,
  generateHistory,
  utcMidnight,
  type HistoryAgent,
  type HistoryEndpoint,
} from "./history";

export { DEFAULT_HISTORY_CALLS };

export const PRIYA_SEED_BALANCE_MICRO = 940_000n;

/** DataCorp's balance after the seed, $12.40 (docs/SEED_DATA.md section 4). */
export const DATACORP_SEED_BALANCE_MICRO = 12_400_000n;

/** Acme Corp's credit limit, $500 (docs/SEED_DATA.md §2). */
export const ACME_CREDIT_LIMIT_MICRO = 500_000_000n;

/** Acme's enterprise rate for Product Search, $0.007 (docs/SEED_DATA.md section 3). */
export const ACME_PRODUCT_SEARCH_RATE_MICRO = 7_000n;

/** The Ledger's unique index keys on ref_id, so the seed uses fixed ones. */
const PRIYA_SEED_REF = "seed:priya-labs-balance";
const DATACORP_SEED_REF = "seed:datacorp-balance";

/**
 * Used for the sellers' `paypal_email` until a human sets the real sandbox emails
 * (PRIYA_PAYPAL_EMAIL and DATACORP_PAYPAL_EMAIL, docs/PAYPAL_SETUP.md). `.invalid` can never
 * receive mail, so a payout to a placeholder fails loudly instead of reaching a stranger.
 */
export const PLACEHOLDER_PAYPAL_EMAILS = {
  priya: "priya-seller@sandbox.invalid",
  datacorp: "datacorp-seller@sandbox.invalid",
};

const SELLER_ORGS = [
  { slug: "priya", name: "Priya Labs", email: "priya@demo.piko", person: "Priya" },
  { slug: "datacorp", name: "DataCorp", email: "omar@datacorp.demo", person: "Omar" },
] as const;

type SellerSlug = (typeof SELLER_ORGS)[number]["slug"];

/** The ~20 synthetic external buyer orgs behind the history (docs/SEED_DATA.md section 5). */
const EXTERNAL_BUYERS = [
  "Northwind Labs",
  "Globex Retail",
  "Initech Data",
  "Umbrella Commerce",
  "Hooli Shopping",
  "Stark Deals",
  "Wayne Procurement",
  "Wonka Market",
  "Soylent Insights",
  "Cyberdyne Compare",
  "Tyrell Finds",
  "Aperture Buyers",
  "Vandelay Imports",
  "Pied Piper Pricing",
  "Dunder Supply",
  "Gringotts Pay",
  "Oscorp Sourcing",
  "Massive Dynamic",
  "Blue Sun Trading",
  "Monarch Outfitters",
] as const;

/** How each Acme agent spends its Calls, by listing slug (SEED_DATA section 5). */
const ACME_AGENT_PROFILES: Record<string, { weight: number; mix: Record<string, number> }> = {
  "campaign-researcher": {
    weight: 25,
    mix: { "product-search": 70, "review-summariser": 20, "price-history": 10 },
  },
  "competitor-watch": {
    weight: 15,
    mix: { "product-search": 60, "review-summariser": 10, "price-history": 30 },
  },
  "ticket-triage": { weight: 20, mix: { "product-search": 20, "review-summariser": 80 } },
  "catalog-sync": { weight: 25, mix: { "product-search": 30, "price-history": 70 } },
  "loop-bot": { weight: 15, mix: { "price-history": 100 } },
};

const EXTERNAL_MIX = {
  "product-search": 40,
  "review-summariser": 25,
  "price-history": 25,
  "cheap-reviews": 10,
};

/** Rows per statement. Each batch is one JSON parameter, so it is one round trip. */
const BULK_BATCH = 4_000;

/** JSON for jsonb_to_recordset: amounts as digit strings so no bigint passes through a number. */
function toJson(rows: readonly object[]): string {
  return JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

async function inBatches<T>(rows: readonly T[], run: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BULK_BATCH) await run(rows.slice(i, i + BULK_BATCH));
}

const LISTINGS: ReadonlyArray<{
  seller: SellerSlug;
  slug: string;
  name: string;
  description: string;
  kind: "http" | "both";
  category: string;
  rating: string;
  method: "GET" | "POST";
  path: string;
  priceMicro: bigint;
  freeQuota: number;
}> = [
  {
    seller: "datacorp",
    slug: "product-search",
    name: "Product Search",
    description: "Search live products by keyword and get names, prices and links.",
    kind: "both",
    category: "search",
    rating: "4.7",
    method: "GET",
    path: "/search",
    priceMicro: 10_000n,
    freeQuota: 5,
  },
  {
    seller: "priya",
    slug: "review-summariser",
    name: "Review Summariser",
    description: "Summarise a product's customer reviews into pros, cons and a verdict.",
    kind: "both",
    category: "reviews",
    rating: "4.6",
    method: "POST",
    path: "/summarise",
    priceMicro: 5_000n,
    freeQuota: 0,
  },
  {
    seller: "priya",
    slug: "price-history",
    name: "Price History",
    description: "Price history for one product over the last 90 days.",
    kind: "both",
    category: "pricing",
    rating: "4.8",
    method: "GET",
    path: "/history",
    priceMicro: 2_000n,
    freeQuota: 0,
  },
  {
    seller: "datacorp",
    slug: "cheap-reviews",
    name: "Cheap Reviews",
    description: "Low-cost review summaries. Cheaper than Review Summariser and rated far lower.",
    kind: "http",
    category: "reviews",
    rating: "2.1",
    method: "POST",
    path: "/summarise",
    priceMicro: 3_000n,
    freeQuota: 0,
  },
];

export interface SeedOptions {
  /** Where the app runs, used exactly as given. Listings point at the sample seller APIs under it. */
  appBaseUrl: string;
  /**
   * Starts Sam's wallet with this many micro-USD instead of $0.00. For running a paid Call
   * before PayPal top-ups (Phase 2) exist; the demo itself starts from a real top-up.
   */
  samWalletMicro?: bigint;
  /** How many simulated Calls of history to create, 0 for none. Defaults to 12,000. */
  historyCalls?: number;
  /** The history's "today": it covers the 29 UTC days before this date's midnight. */
  now?: Date;
  /** PLATFORM_FEE_BPS for the history's fee split. Defaults to the env var, then 500. */
  platformFeeBps?: number;
  /** The sandbox sellers' PayPal emails, for payouts. Placeholders when unset. */
  sellerPaypalEmails?: { priya?: string; datacorp?: string };
}

export interface SeedResult {
  /** Sam's raw agent Key, the only time it is available. */
  samKey: string;
}

/**
 * Empties every application table, then creates the demo world, all in one transaction.
 * TRUNCATE is the only way to clear the Ledger: its trigger rejects DELETE.
 */
export function seed(
  db: Db,
  {
    appBaseUrl,
    samWalletMicro,
    historyCalls = DEFAULT_HISTORY_CALLS,
    now = new Date(),
    platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? 500),
    sellerPaypalEmails = {},
  }: SeedOptions,
): Promise<SeedResult> {
  // Exactly as given: no trimming, no fallback to localhost.
  const sellersBaseUrl = `${appBaseUrl}/api/demo/sellers`;
  const paypalEmails = {
    priya: sellerPaypalEmails.priya || PLACEHOLDER_PAYPAL_EMAILS.priya,
    datacorp: sellerPaypalEmails.datacorp || PLACEHOLDER_PAYPAL_EMAILS.datacorp,
  };

  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const tables = rows.map(({ tablename }) => sql.identifier(tablename));
    await tx.execute(sql`truncate table ${sql.join(tables, sql`, `)} restart identity cascade`);

    async function createOrg(values: typeof orgs.$inferInsert, person: string, email: string) {
      const [org] = await tx.insert(orgs).values(values).returning({ id: orgs.id });
      const [account] = await tx
        .insert(accounts)
        .values({ email, name: person })
        .returning({ id: accounts.id });
      await tx
        .insert(memberships)
        .values({ accountId: account!.id, orgId: org!.id, role: "admin" });
      return org!.id;
    }

    const samOrgId = await createOrg(
      { name: "Sam (personal)", slug: "sam", kind: "personal", billing: "prepaid" },
      "Sam",
      "sam@demo.piko",
    );
    const [samAgent] = await tx
      .insert(agents)
      // "Notify above" $0.05 per call (SEED_DATA section 2).
      .values({ orgId: samOrgId, name: "shopping-assistant", notifyAboveMicro: 50_000n })
      .returning({ id: agents.id });
    const samKey = await createKey(tx, samAgent!.id);
    // $1.00 per task.
    await createBudget(tx, {
      orgId: samOrgId,
      scopeType: "agent",
      scopeId: samAgent!.id,
      period: "task",
      maxMicro: 1_000_000n,
      category: null,
    });

    const acmeOrgId = await createOrg(
      {
        name: "Acme Corp",
        slug: "acme",
        kind: "company",
        billing: "invoiced",
        creditLimitMicro: ACME_CREDIT_LIMIT_MICRO,
      },
      "Dana",
      "dana@acme.demo",
    );

    const sellerOrgIds = new Map<SellerSlug, string>();
    for (const { slug, name, email, person } of SELLER_ORGS) {
      const orgId = await createOrg(
        { name, slug, kind: "company", billing: "prepaid", paypalEmail: paypalEmails[slug] },
        person,
        email,
      );
      sellerOrgIds.set(slug, orgId);
    }

    const historyEndpoints: HistoryEndpoint[] = [];
    for (const { seller, method, path, priceMicro, freeQuota, ...listing } of LISTINGS) {
      const [row] = await tx
        .insert(listings)
        .values({
          ...listing,
          sellerOrgId: sellerOrgIds.get(seller)!,
          baseUrl: `${sellersBaseUrl}/${listing.slug}`,
        })
        .returning({ id: listings.id });
      const [endpoint] = await tx
        .insert(endpoints)
        .values({ listingId: row!.id, method, pathOrTool: path, priceMicro, freeQuota })
        .returning({ id: endpoints.id });
      historyEndpoints.push({
        slug: listing.slug,
        endpointId: endpoint!.id,
        sellerOrgId: sellerOrgIds.get(seller)!,
        priceMicro,
        freeQuota,
      });
    }

    if (samWalletMicro && samWalletMicro > 0n) {
      await tx.insert(ledgerEntries).values({
        txnId: sql`gen_random_uuid()`,
        accountType: "wallet",
        orgId: samOrgId,
        amountMicro: samWalletMicro,
        reason: "seed",
        refId: "seed:sam-wallet",
      });
    }

    // Acme's teams, agents and monthly budgets, then its enterprise rate and Policies.
    await seedAcmeTemp(tx);
    const acmeTeams = await tx.select().from(teams).where(eq(teams.orgId, acmeOrgId));
    const acmeAgentRows = await tx.select().from(agents).where(eq(agents.orgId, acmeOrgId));
    const productSearch = historyEndpoints.find((e) => e.slug === "product-search")!;
    await tx.insert(rateOverrides).values({
      endpointId: productSearch.endpointId,
      buyerOrgId: acmeOrgId,
      priceMicro: ACME_PRODUCT_SEARCH_RATE_MICRO,
    });

    // Acme's two Policies, stored already compiled and confirmed. Every document goes through
    // parsePolicyDocument so a bad one fails the seed, not every payment in the org.
    //
    // Policy 1 in SEED_DATA also says "anything over 5 cents a call needs my OK". That is an
    // `approval_above` rule, and approvals (P5-04) aren't built: on main a matching
    // `approval_above` DENIES the Call, which would block the demo. So only its budget half is
    // seeded, and the source text says so. Add the approval rule when P5-04 lands.
    const marketingTeam = acmeTeams.find((team) => team.name === "Marketing")!;
    const confirmedAt = new Date(now);
    const searchBudget = parsePolicyDocument({
      scope: { team: marketingTeam.id },
      rules: [{ type: "budget", category: "search", period: "month", maxMicroUsd: 50_000_000 }],
    });
    const vendorBlock = parsePolicyDocument({
      scope: { org: true },
      rules: [{ type: "vendor_block", vendors: ["Cheap Reviews"] }],
    });
    await tx.insert(policies).values([
      {
        orgId: acmeOrgId,
        sourceText: "Marketing agents can't spend more than $50 a month on search.",
        compiledJson: policyDocumentToJson(searchBudget),
        confirmedAt,
      },
      {
        orgId: acmeOrgId,
        sourceText: "Nobody at Acme may use the 'Cheap Reviews' API.",
        compiledJson: policyDocumentToJson(vendorBlock),
        confirmedAt,
      },
    ]);
    // Confirming the first Policy turns its budget rule into a Budget, as lib/policy does.
    await createBudget(tx, {
      orgId: acmeOrgId,
      scopeType: "team",
      scopeId: marketingTeam.id,
      period: "month",
      maxMicro: 50_000_000n,
      category: "search",
    });

    // ~20 synthetic external buyer orgs, one Agent each. Prepaid, funded below.
    const buyerOrgs = await tx
      .insert(orgs)
      .values(
        EXTERNAL_BUYERS.map((name, i) => ({
          name,
          slug: `buyer-${String(i + 1).padStart(2, "0")}`,
          kind: "company" as const,
          billing: "prepaid" as const,
        })),
      )
      .returning({ id: orgs.id, slug: orgs.slug });
    buyerOrgs.sort((a, b) => a.slug.localeCompare(b.slug));
    const buyerAgentRows = await tx
      .insert(agents)
      .values(buyerOrgs.map((org) => ({ orgId: org.id, name: "buyer-agent" })))
      .returning({ id: agents.id, orgId: agents.orgId });

    const acmeAgents: HistoryAgent[] = acmeAgentRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({
        agentId: agent.id,
        orgId: acmeOrgId,
        name: agent.name,
        weight: ACME_AGENT_PROFILES[agent.name]!.weight,
        mix: ACME_AGENT_PROFILES[agent.name]!.mix,
        acme: true,
      }));
    const externalAgents: HistoryAgent[] = buyerOrgs.map((org, i) => ({
      agentId: buyerAgentRows.find((agent) => agent.orgId === org.id)!.id,
      orgId: org.id,
      name: "buyer-agent",
      // Uneven but fixed: some buyers are much busier than others.
      weight: 1 + ((i * 7) % 5),
      mix: EXTERNAL_MIX,
      acme: false,
    }));

    // History: the 29 UTC days before today's midnight, so timestamps don't depend on the clock.
    const anchor = utcMidnight(now);
    const history = generateHistory({
      calls: historyCalls,
      anchor,
      feeBps: BigInt(platformFeeBps),
      endpoints: historyEndpoints,
      acmePrices: { "product-search": ACME_PRODUCT_SEARCH_RATE_MICRO },
      acmeAgents,
      externalAgents,
      acmeShare: 0.65,
    });
    // Bulk-load thousands of rows through jsonb_to_recordset: much faster than a multi-row
    // INSERT with tens of thousands of bind parameters, and quick over a remote connection.
    await inBatches(history.calls, (batch) =>
      tx.execute(sql`
        insert into calls (id, agent_id, buyer_org_id, endpoint_id, amount_micro, status,
          block_reason, upstream_status, latency_ms, simulated, created_at)
        select id, agent_id, buyer_org_id, endpoint_id, amount_micro, status,
          block_reason, upstream_status, latency_ms, simulated, created_at
        from jsonb_to_recordset(${toJson(
          batch.map((call) => ({
            id: call.id,
            agent_id: call.agentId,
            buyer_org_id: call.buyerOrgId,
            endpoint_id: call.endpointId,
            amount_micro: call.amountMicro,
            status: call.status,
            block_reason: call.blockReason,
            upstream_status: call.upstreamStatus,
            latency_ms: call.latencyMs,
            simulated: call.simulated,
            created_at: call.createdAt,
          })),
        )}::jsonb) as r(id uuid, agent_id uuid, buyer_org_id uuid, endpoint_id uuid,
          amount_micro bigint, status call_status, block_reason text, upstream_status integer,
          latency_ms integer, simulated boolean, created_at timestamptz)`),
    );
    await inBatches(history.entries, (batch) =>
      tx.execute(sql`
        insert into ledger_entries (txn_id, account_type, org_id, amount_micro, reason, ref_id,
          created_at)
        select txn_id, account_type, org_id, amount_micro, reason, ref_id, created_at
        from jsonb_to_recordset(${toJson(
          batch.map((entry) => ({
            txn_id: entry.txnId,
            account_type: entry.accountType,
            org_id: entry.orgId,
            amount_micro: entry.amountMicro,
            reason: entry.reason,
            ref_id: entry.refId,
            created_at: entry.createdAt,
          })),
        )}::jsonb) as r(txn_id uuid, account_type ledger_account, org_id uuid,
          amount_micro bigint, reason ledger_reason, ref_id text, created_at timestamptz)`),
    );

    // Alerts for the blocked Calls and one breaker trip on `loop-bot` 9 days ago. The agent is
    // not left frozen: the demo trips the breaker live.
    const nameOf = new Map(acmeAgentRows.map((agent) => [agent.id, agent.name]));
    const loopBot = acmeAgentRows.find((agent) => agent.name === "loop-bot")!;
    await tx.insert(alerts).values([
      {
        orgId: acmeOrgId,
        agentId: loopBot.id,
        type: BREAKER_TRIPPED,
        message: "Circuit breaker froze loop-bot: 50 calls in 10 seconds (simulated).",
        createdAt: new Date(anchor.getTime() - 9 * DAY_MS + 10 * 3_600_000),
      },
      ...history.calls
        .filter((call) => call.status === "blocked")
        .map((call) => ({
          orgId: acmeOrgId,
          agentId: call.agentId,
          type: call.blockReason === "policy_denied" ? POLICY_ALERT_TYPE : BUDGET_ALERT_TYPE,
          message:
            call.blockReason === "policy_denied"
              ? `${nameOf.get(call.agentId)} was blocked from Cheap Reviews by a vendor-block policy (simulated).`
              : `${nameOf.get(call.agentId)} hit its monthly search budget (simulated).`,
          createdAt: call.createdAt,
        })),
    ]);

    // Funding. Prepaid buyers get a `seed` top-up that covers their history; Acme is invoiced and
    // draws on its credit limit instead. Sellers get a `seed` entry that pins their balance to
    // the doc's figure: history already paid out is simulated, never a fake PayPal Payout.
    const spent = new Map<string, bigint>();
    const earned = new Map<string, bigint>();
    for (const entry of history.entries) {
      if (entry.accountType === "wallet") {
        spent.set(entry.orgId!, (spent.get(entry.orgId!) ?? 0n) - entry.amountMicro);
      } else if (entry.accountType === "seller") {
        earned.set(entry.orgId!, (earned.get(entry.orgId!) ?? 0n) + entry.amountMicro);
      }
    }
    const dollar = 1_000_000n;
    const funding = buyerOrgs.flatMap((org) => {
      const owed = spent.get(org.id) ?? 0n;
      if (owed === 0n) return [];
      return [
        {
          txnId: sql`gen_random_uuid()`,
          accountType: "wallet" as const,
          orgId: org.id,
          // Whole dollars, with a dollar to spare.
          amountMicro: ((owed + dollar - 1n) / dollar + 1n) * dollar,
          reason: "seed" as const,
          refId: `seed:wallet:${org.slug}`,
          createdAt: new Date(anchor.getTime() - 30 * DAY_MS),
        },
      ];
    });
    const pins = [
      { orgId: sellerOrgIds.get("priya")!, target: PRIYA_SEED_BALANCE_MICRO, ref: PRIYA_SEED_REF },
      {
        orgId: sellerOrgIds.get("datacorp")!,
        target: DATACORP_SEED_BALANCE_MICRO,
        ref: DATACORP_SEED_REF,
      },
    ].map(({ orgId, target, ref }) => ({
      txnId: sql`gen_random_uuid()`,
      accountType: "seller" as const,
      orgId,
      amountMicro: target - (earned.get(orgId) ?? 0n),
      reason: "seed" as const,
      refId: ref,
    }));
    await tx.insert(ledgerEntries).values([...funding, ...pins]);

    // Fresh bulk-loaded tables have no planner statistics until autovacuum gets to them, and
    // the spend grid's join over thousands of Calls is very slow without them.
    await tx.execute(sql`analyze calls`);
    await tx.execute(sql`analyze ledger_entries`);

    return { samKey: samKey.rawKey };
  });
}
