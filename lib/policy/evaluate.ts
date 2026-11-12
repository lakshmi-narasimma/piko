/**
 * The Policy evaluator: a pure function from an org's confirmed Policies and one payment to
 * allow, deny or needs-approval. It reads no clock, database or model, so the same input
 * always gives the same answer.
 *
 * Every Policy that applies counts: the org's, the payer's team's and the payer Agent's.
 * Checks run in the order of docs/DESIGN.md section 9, each across all those Policies before
 * the next: vendor block and allow, then max price per call, then approval above an amount.
 * The first check that fails decides, so any deny wins over a later needs-approval.
 * Budget rules are not checked here: confirming a Policy turns them into Budgets, which the
 * pipeline's `budget` step enforces.
 */
import { formatUsd } from "../money";
import type { PolicyDocument, PolicyRule, PolicyRuleType } from "./schema";

/** A confirmed Policy, with its scope resolved to ids. */
export interface PolicyRecord {
  id: string;
  orgId: string;
  /** What the admin typed: the Policy's name in errors and alerts. */
  name: string;
  document: PolicyDocument;
}

/** The payment being checked. */
export interface PolicyCallContext {
  orgId: string;
  teamId: string | null;
  agentId: string;
  vendor: { sellerSlug: string; sellerName: string; listingSlug: string; listingName: string };
  category: string | null;
  priceMicro: bigint;
}

export type PolicyDecision =
  | { outcome: "allow" }
  | {
      outcome: "deny";
      policyId: string;
      policyName: string;
      rule: Exclude<PolicyRuleType, "approval_above" | "budget">;
      reason: string;
    }
  | { outcome: "needs_approval"; policyId: string; policyName: string; thresholdMicro: bigint };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether a Policy covers this payer. Another org's Policy never does. */
export function policyApplies(policy: PolicyRecord, context: PolicyCallContext): boolean {
  if (policy.orgId !== context.orgId) return false;
  const { scope } = policy.document;
  if ("org" in scope) return true;
  if ("team" in scope) return context.teamId !== null && scope.team === context.teamId;
  return scope.agent === context.agentId;
}

function vendorMatches(vendors: readonly string[], context: PolicyCallContext): boolean {
  const { sellerSlug, sellerName, listingSlug, listingName } = context.vendor;
  const names = [sellerSlug, sellerName, listingSlug, listingName];
  return vendors.some((vendor) => names.some((n) => same(vendor, n)));
}

function inCategory(rule: { category?: string }, context: PolicyCallContext): boolean {
  return (
    rule.category === undefined ||
    (context.category !== null && same(rule.category, context.category))
  );
}

type Rule<T extends PolicyRuleType> = Extract<PolicyRule, { type: T }>;

function* rulesOf<T extends PolicyRuleType>(
  policies: readonly PolicyRecord[],
  type: T,
): Generator<[PolicyRecord, Rule<T>]> {
  for (const policy of policies) {
    for (const rule of policy.document.rules) {
      if (rule.type === type) yield [policy, rule as Rule<T>];
    }
  }
}

export function evaluatePolicies(
  policies: readonly PolicyRecord[],
  context: PolicyCallContext,
): PolicyDecision {
  const applying = policies.filter((policy) => policyApplies(policy, context));
  const vendor = context.vendor.listingName;

  // 1. Vendor block and allow.
  for (const policy of applying) {
    for (const rule of policy.document.rules) {
      if (rule.type === "vendor_block" && vendorMatches(rule.vendors, context)) {
        return deny(policy, rule.type, `${vendor} is a blocked vendor.`);
      }
      if (rule.type === "vendor_allow" && !vendorMatches(rule.vendors, context)) {
        return deny(policy, rule.type, `${vendor} is not on the allowed vendor list.`);
      }
    }
  }

  // 2. Max price per call.
  for (const [policy, rule] of rulesOf(applying, "max_price_per_call")) {
    if (inCategory(rule, context) && context.priceMicro > rule.maxMicroUsd) {
      return deny(
        policy,
        rule.type,
        `This call costs ${formatUsd(context.priceMicro)}, over the ${formatUsd(rule.maxMicroUsd)} per-call limit.`,
      );
    }
  }

  // 3. Approval above an amount.
  for (const [policy, rule] of rulesOf(applying, "approval_above")) {
    if (inCategory(rule, context) && context.priceMicro > rule.maxMicroUsd) {
      return {
        outcome: "needs_approval",
        policyId: policy.id,
        policyName: policy.name,
        thresholdMicro: rule.maxMicroUsd,
      };
    }
  }

  return { outcome: "allow" };
}

function deny(
  policy: PolicyRecord,
  rule: "vendor_block" | "vendor_allow" | "max_price_per_call",
  reason: string,
): PolicyDecision {
  return { outcome: "deny", policyId: policy.id, policyName: policy.name, rule, reason };
}
