/**
 * A Policy document in plain English, for the Org console. The compiler preview and the saved
 * list show these lines, so the admin confirms exactly what will be enforced. Pure: no
 * database, and dollars come only from `formatUsd`.
 */
import { formatUsd } from "../money";
import type { PolicyDocument, PolicyRule, PolicyScope } from "./schema";

export interface PolicyLabels {
  /** The team or Agent's name, when the document's scope holds an id. */
  scope?: string;
}

const PERIOD = { day: "per day", month: "per month", task: "per task" } as const;

function scopeLine(scope: PolicyScope, labels: PolicyLabels): string {
  if ("org" in scope) return "Applies to: the whole org";
  if ("team" in scope) return `Applies to: the ${labels.scope ?? scope.team} team`;
  return `Applies to: the agent ${labels.scope ?? scope.agent}`;
}

function inCategory(category: string | undefined): string {
  return category ? ` in the ${category} category` : "";
}

function ruleLine(rule: PolicyRule): string {
  switch (rule.type) {
    case "vendor_block":
      return `Blocks calls to ${rule.vendors.join(", ")}`;
    case "vendor_allow":
      return `Only allows calls to ${rule.vendors.join(", ")}`;
    case "max_price_per_call":
      return `Blocks any single call priced above ${formatUsd(rule.maxMicroUsd)}${inCategory(rule.category)}`;
    case "approval_above":
      // P5-04 isn't live: the pay pipeline denies these calls instead of asking.
      return `Calls over ${formatUsd(rule.maxMicroUsd)}${inCategory(rule.category)} need approval. Note: approvals aren't live yet, so these calls will be blocked`;
    case "budget":
      return `Blocks spending above ${formatUsd(rule.maxMicroUsd)} ${PERIOD[rule.period]}${rule.category ? ` on ${rule.category}` : ""}`;
  }
}

/** One line for the scope, then one per rule. */
export function describePolicy(document: PolicyDocument, labels: PolicyLabels = {}): string[] {
  return [scopeLine(document.scope, labels), ...document.rules.map(ruleLine)];
}
