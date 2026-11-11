CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('day', 'month', 'task');--> statement-breakpoint
CREATE TYPE "public"."budget_scope" AS ENUM('org', 'team', 'agent');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('paid', 'free', 'refunded', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('wallet', 'seller', 'platform');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('call', 'refund', 'topup', 'payout', 'payout_reversal', 'invoice_settlement', 'seed');--> statement-breakpoint
CREATE TYPE "public"."listing_kind" AS ENUM('http', 'mcp', 'both');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."org_billing" AS ENUM('prepaid', 'invoiced');--> statement-breakpoint
CREATE TYPE "public"."org_kind" AS ENUM('personal', 'company');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'settled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."topup_status" AS ENUM('created', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"notify_above_micro" bigint,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_notify_above_non_negative" CHECK ("agents"."notify_above_micro" is null or "agents"."notify_above_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid,
	"challenge_nonce" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_challenge_nonce_unique" UNIQUE("challenge_nonce"),
	CONSTRAINT "approvals_amount_non_negative" CHECK ("approvals"."amount_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" "budget_scope" NOT NULL,
	"scope_id" uuid NOT NULL,
	"period" "budget_period" NOT NULL,
	"max_micro" bigint NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_max_non_negative" CHECK ("budgets"."max_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text,
	"agent_id" uuid NOT NULL,
	"buyer_org_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"amount_micro" bigint NOT NULL,
	"status" "call_status" NOT NULL,
	"block_reason" text,
	"upstream_status" integer,
	"latency_ms" integer,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "calls_amount_non_negative" CHECK ("calls"."amount_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"agent_id" uuid,
	"buyer_org_id" uuid,
	"amount_micro" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reserved_at" timestamp with time zone,
	"reservation_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "challenges_amount_non_negative" CHECK ("challenges"."amount_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path_or_tool" text NOT NULL,
	"price_micro" bigint NOT NULL,
	"free_quota" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoints_price_non_negative" CHECK ("endpoints"."price_micro" >= 0),
	CONSTRAINT "endpoints_free_quota_non_negative" CHECK ("endpoints"."free_quota" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"paypal_invoice_id" text,
	"period" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_paypal_invoice_id_unique" UNIQUE("paypal_invoice_id"),
	CONSTRAINT "invoices_amount_non_negative" CHECK ("invoices"."amount_micro" >= 0),
	CONSTRAINT "invoices_period_format" CHECK ("invoices"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"txn_id" uuid NOT NULL,
	"account_type" "ledger_account" NOT NULL,
	"org_id" uuid,
	"amount_micro" bigint NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"ref_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_platform_has_no_org" CHECK (("ledger_entries"."account_type" = 'platform') = ("ledger_entries"."org_id" is null))
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"base_url" text NOT NULL,
	"kind" "listing_kind" NOT NULL,
	"category" text,
	"rating" numeric(2, 1),
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"account_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	CONSTRAINT "memberships_account_id_org_id_pk" PRIMARY KEY("account_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "org_kind" NOT NULL,
	"billing" "org_billing" NOT NULL,
	"credit_limit_micro" bigint DEFAULT 0 NOT NULL,
	"paypal_email" text,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "orgs_credit_limit_non_negative" CHECK ("orgs"."credit_limit_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_org_id" uuid NOT NULL,
	"paypal_batch_id" text,
	"paypal_item_id" text,
	"amount_micro" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_paypal_batch_id_unique" UNIQUE("paypal_batch_id"),
	CONSTRAINT "payouts_paypal_item_id_unique" UNIQUE("paypal_item_id"),
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount_micro" > 0)
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_text" text NOT NULL,
	"compiled_json" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"buyer_org_id" uuid NOT NULL,
	"price_micro" bigint NOT NULL,
	CONSTRAINT "rate_overrides_price_non_negative" CHECK ("rate_overrides"."price_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"paypal_order_id" text NOT NULL,
	"paypal_capture_id" text,
	"amount_micro" bigint NOT NULL,
	"status" "topup_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topups_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "topups_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "topups_amount_positive" CHECK ("topups"."amount_micro" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_paypal_event_id_unique" UNIQUE("paypal_event_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_challenge_nonce_challenges_nonce_fk" FOREIGN KEY ("challenge_nonce") REFERENCES "public"."challenges"("nonce") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_nonce_challenges_nonce_fk" FOREIGN KEY ("nonce") REFERENCES "public"."challenges"("nonce") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_buyer_org_id_orgs_id_fk" FOREIGN KEY ("buyer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_buyer_org_id_orgs_id_fk" FOREIGN KEY ("buyer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_org_id_orgs_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_org_id_orgs_id_fk" FOREIGN KEY ("seller_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_overrides" ADD CONSTRAINT "rate_overrides_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_overrides" ADD CONSTRAINT "rate_overrides_buyer_org_id_orgs_id_fk" FOREIGN KEY ("buyer_org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_name_unique" ON "agents" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "agents_team_idx" ON "agents" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "alerts_org_created_idx" ON "alerts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_agent_idx" ON "api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "approvals_org_status_idx" ON "approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "budgets_scope_idx" ON "budgets" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "budgets_org_idx" ON "budgets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "calls_agent_created_idx" ON "calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_buyer_created_idx" ON "calls" USING btree ("buyer_org_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_buyer_endpoint_status_idx" ON "calls" USING btree ("buyer_org_id","endpoint_id","status");--> statement-breakpoint
CREATE INDEX "calls_endpoint_created_idx" ON "calls" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "challenges_endpoint_idx" ON "challenges" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "challenges_buyer_reservation_idx" ON "challenges" USING btree ("buyer_org_id","reservation_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoints_listing_route_unique" ON "endpoints" USING btree ("listing_id","method","path_or_tool");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_period_unique" ON "invoices" USING btree ("org_id","period");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_org_idx" ON "ledger_entries" USING btree ("account_type","org_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_txn_idx" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_once_per_event" ON "ledger_entries" USING btree ("reason","ref_id","account_type");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_seller_slug_unique" ON "listings" USING btree ("seller_org_id","slug");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payouts_seller_idx" ON "payouts" USING btree ("seller_org_id");--> statement-breakpoint
CREATE INDEX "policies_org_idx" ON "policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_overrides_endpoint_buyer_unique" ON "rate_overrides" USING btree ("endpoint_id","buyer_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_name_unique" ON "teams" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "topups_org_idx" ON "topups" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_once_per_resource" ON "webhook_events" USING btree ("event_type","resource_id");