/**
 * Drizzle table definitions (DESIGN.md section 12). drizzle-kit reads this file to
 * generate migrations.
 *
 * Amounts are `bigint("..._micro", { mode: "bigint" })` so they never pass through a JS
 * number. Only `lib/ledger` writes `ledger_entries`; a database trigger rejects updates
 * and deletes on that table.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Matches GEMINI_EMBEDDING_DIMENSIONS; changing it needs a migration. */
export const EMBEDDING_DIMENSIONS = 768;

const id = () => uuid("id").primaryKey().defaultRandom();
const micro = (name: string) => bigint(name, { mode: "bigint" });
const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at("created_at").notNull().defaultNow();

export const orgKind = pgEnum("org_kind", ["personal", "company"]);
export const orgBilling = pgEnum("org_billing", ["prepaid", "invoiced"]);
export const memberRole = pgEnum("member_role", ["admin", "member"]);
export const budgetScope = pgEnum("budget_scope", ["org", "team", "agent"]);
export const budgetPeriod = pgEnum("budget_period", ["day", "month", "task"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "denied"]);
export const listingKind = pgEnum("listing_kind", ["http", "mcp", "both"]);
export const callStatus = pgEnum("call_status", ["paid", "free", "refunded", "blocked"]);
export const ledgerAccount = pgEnum("ledger_account", ["wallet", "seller", "platform"]);
export const ledgerReason = pgEnum("ledger_reason", [
  "call",
  "refund",
  "topup",
  "payout",
  "payout_reversal",
  "invoice_settlement",
  "seed",
]);
export const topupStatus = pgEnum("topup_status", ["created", "completed", "failed"]);
export const payoutStatus = pgEnum("payout_status", ["pending", "settled", "failed"]);
export const invoiceStatus = pgEnum("invoice_status", ["draft", "sent", "paid", "cancelled"]);

export const accounts = pgTable("accounts", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

export const orgs = pgTable(
  "orgs",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    kind: orgKind("kind").notNull(),
    billing: orgBilling("billing").notNull(),
    creditLimitMicro: micro("credit_limit_micro")
      .notNull()
      .default(sql`0`),
    paypalEmail: text("paypal_email"),
    frozenAt: at("frozen_at"),
    createdAt: createdAt(),
  },
  (t) => [check("orgs_credit_limit_non_negative", sql`${t.creditLimitMicro} >= 0`)],
);

export const memberships = pgTable(
  "memberships",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    role: memberRole("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.orgId] }),
    index("memberships_org_idx").on(t.orgId),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    frozenAt: at("frozen_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("teams_org_name_unique").on(t.orgId, t.name)],
);

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    teamId: uuid("team_id").references(() => teams.id),
    name: text("name").notNull(),
    notifyAboveMicro: micro("notify_above_micro"),
    frozenAt: at("frozen_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agents_org_name_unique").on(t.orgId, t.name),
    index("agents_team_idx").on(t.teamId),
    check(
      "agents_notify_above_non_negative",
      sql`${t.notifyAboveMicro} is null or ${t.notifyAboveMicro} >= 0`,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    hash: text("hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    revokedAt: at("revoked_at"),
  },
  (t) => [index("api_keys_agent_idx").on(t.agentId)],
);

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    scopeType: budgetScope("scope_type").notNull(),
    // An org, team or agent id, according to scope_type.
    scopeId: uuid("scope_id").notNull(),
    period: budgetPeriod("period").notNull(),
    maxMicro: micro("max_micro").notNull(),
    category: text("category"),
    createdAt: createdAt(),
  },
  (t) => [
    index("budgets_scope_idx").on(t.scopeType, t.scopeId),
    index("budgets_org_idx").on(t.orgId),
    check("budgets_max_non_negative", sql`${t.maxMicro} >= 0`),
  ],
);

export const policies = pgTable(
  "policies",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    sourceText: text("source_text").notNull(),
    compiledJson: jsonb("compiled_json").notNull(),
    // Not enforced until an admin confirms it.
    confirmedAt: at("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("policies_org_idx").on(t.orgId)],
);

export const listings = pgTable(
  "listings",
  {
    id: id(),
    sellerOrgId: uuid("seller_org_id")
      .notNull()
      .references(() => orgs.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    baseUrl: text("base_url").notNull(),
    kind: listingKind("kind").notNull(),
    category: text("category"),
    rating: numeric("rating", { precision: 2, scale: 1 }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("listings_seller_slug_unique").on(t.sellerOrgId, t.slug)],
);

export const endpoints = pgTable(
  "endpoints",
  {
    id: id(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    // An HTTP method, or TOOL for an MCP tool.
    method: text("method").notNull(),
    pathOrTool: text("path_or_tool").notNull(),
    priceMicro: micro("price_micro").notNull(),
    freeQuota: integer("free_quota").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("endpoints_listing_route_unique").on(t.listingId, t.method, t.pathOrTool),
    check("endpoints_price_non_negative", sql`${t.priceMicro} >= 0`),
    check("endpoints_free_quota_non_negative", sql`${t.freeQuota} >= 0`),
  ],
);

export const rateOverrides = pgTable(
  "rate_overrides",
  {
    id: id(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    buyerOrgId: uuid("buyer_org_id")
      .notNull()
      .references(() => orgs.id),
    priceMicro: micro("price_micro").notNull(),
  },
  (t) => [
    uniqueIndex("rate_overrides_endpoint_buyer_unique").on(t.endpointId, t.buyerOrgId),
    check("rate_overrides_price_non_negative", sql`${t.priceMicro} >= 0`),
  ],
);

export const challenges = pgTable(
  "challenges",
  {
    nonce: text("nonce").primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    // Unknown when the 402 is issued to a caller that sent no key; set by POST /api/pay.
    agentId: uuid("agent_id").references(() => agents.id),
    buyerOrgId: uuid("buyer_org_id").references(() => orgs.id),
    amountMicro: micro("amount_micro").notNull(),
    expiresAt: at("expires_at").notNull(),
    // A reservation holds funds while reserved_at is set, consumed_at is null and
    // reservation_expires_at is in the future.
    reservedAt: at("reserved_at"),
    reservationExpiresAt: at("reservation_expires_at"),
    consumedAt: at("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("challenges_endpoint_idx").on(t.endpointId),
    index("challenges_buyer_reservation_idx").on(t.buyerOrgId, t.reservationExpiresAt),
    check("challenges_amount_non_negative", sql`${t.amountMicro} >= 0`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    policyId: uuid("policy_id").references(() => policies.id),
    challengeNonce: text("challenge_nonce")
      .notNull()
      .unique()
      .references(() => challenges.nonce),
    amountMicro: micro("amount_micro").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => accounts.id),
    decidedAt: at("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("approvals_org_status_idx").on(t.orgId, t.status),
    check("approvals_amount_non_negative", sql`${t.amountMicro} >= 0`),
  ],
);

export const calls = pgTable(
  "calls",
  {
    id: id(),
    // Null for free and simulated Calls, which have no Challenge.
    nonce: text("nonce")
      .unique()
      .references(() => challenges.nonce),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    buyerOrgId: uuid("buyer_org_id")
      .notNull()
      .references(() => orgs.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    amountMicro: micro("amount_micro").notNull(),
    status: callStatus("status").notNull(),
    // Why a blocked Call was blocked, using the API's error codes (e.g. policy_denied).
    blockReason: text("block_reason"),
    upstreamStatus: integer("upstream_status"),
    latencyMs: integer("latency_ms"),
    simulated: boolean("simulated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("calls_agent_created_idx").on(t.agentId, t.createdAt),
    index("calls_buyer_created_idx").on(t.buyerOrgId, t.createdAt),
    index("calls_buyer_endpoint_status_idx").on(t.buyerOrgId, t.endpointId, t.status),
    index("calls_endpoint_created_idx").on(t.endpointId, t.createdAt),
    check("calls_amount_non_negative", sql`${t.amountMicro} >= 0`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    txnId: uuid("txn_id").notNull(),
    accountType: ledgerAccount("account_type").notNull(),
    // Null only for the platform account.
    orgId: uuid("org_id").references(() => orgs.id),
    // Signed: credits are positive, debits negative.
    amountMicro: micro("amount_micro").notNull(),
    reason: ledgerReason("reason").notNull(),
    // What the entry is for: a Call id, PayPal capture id, payout id or invoice id.
    refId: text("ref_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_account_org_idx").on(t.accountType, t.orgId),
    index("ledger_entries_txn_idx").on(t.txnId),
    // Posting the same event twice fails here, even if a caller's own check is missed.
    uniqueIndex("ledger_entries_once_per_event").on(t.reason, t.refId, t.accountType),
    check(
      "ledger_entries_platform_has_no_org",
      sql`(${t.accountType} = 'platform') = (${t.orgId} is null)`,
    ),
  ],
);

export const topups = pgTable(
  "topups",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    paypalOrderId: text("paypal_order_id").notNull().unique(),
    paypalCaptureId: text("paypal_capture_id").unique(),
    amountMicro: micro("amount_micro").notNull(),
    status: topupStatus("status").notNull().default("created"),
    createdAt: createdAt(),
  },
  (t) => [
    index("topups_org_idx").on(t.orgId),
    check("topups_amount_positive", sql`${t.amountMicro} > 0`),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    sellerOrgId: uuid("seller_org_id")
      .notNull()
      .references(() => orgs.id),
    // Null until PayPal accepts the batch.
    paypalBatchId: text("paypal_batch_id").unique(),
    paypalItemId: text("paypal_item_id").unique(),
    amountMicro: micro("amount_micro").notNull(),
    status: payoutStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payouts_seller_idx").on(t.sellerOrgId),
    check("payouts_amount_positive", sql`${t.amountMicro} > 0`),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    paypalInvoiceId: text("paypal_invoice_id").unique(),
    // Calendar month, as YYYY-MM.
    period: text("period").notNull(),
    amountMicro: micro("amount_micro").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_org_period_unique").on(t.orgId, t.period),
    check("invoices_amount_non_negative", sql`${t.amountMicro} >= 0`),
    check("invoices_period_format", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    agentId: uuid("agent_id").references(() => agents.id),
    type: text("type").notNull(),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("alerts_org_created_idx").on(t.orgId, t.createdAt)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    paypalEventId: text("paypal_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    // The PayPal resource the event is about: a capture, payout item or invoice id.
    resourceId: text("resource_id").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: at("received_at").notNull().defaultNow(),
    processedAt: at("processed_at"),
  },
  (t) => [uniqueIndex("webhook_events_once_per_resource").on(t.eventType, t.resourceId)],
);
