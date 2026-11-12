/**
 * The alert shapes and labels the browser needs, kept apart from lib/alerts' database code so
 * client components can import them.
 */

/** The type the circuit breaker writes. Equal to lib/breaker's BREAKER_ALERT_TYPE (tested). */
export const BREAKER_TRIPPED = "breaker_tripped";

/** The alert type a payment blocked by a Budget writes. */
export const BUDGET_ALERT_TYPE = "budget_exceeded";

/** The alert type a payment blocked by a Policy writes. */
export const POLICY_ALERT_TYPE = "policy_denied";

/** One alert as the panel shows it. */
export interface AlertView {
  id: string;
  type: string;
  agentId: string | null;
  /** The Agent's name, or null for an org-wide alert. */
  agent: string | null;
  message: string;
  createdAt: string;
}

export type AlertKind = "breaker" | "budget" | "policy" | "frozen" | "unfrozen" | "other";

/** What the panel calls an alert type. Unknown types still show, under their own name. */
export function describeAlertType(type: string): { kind: AlertKind; label: string } {
  if (type === BREAKER_TRIPPED) return { kind: "breaker", label: "Breaker tripped" };
  if (type === BUDGET_ALERT_TYPE) return { kind: "budget", label: "Budget hit" };
  if (type.startsWith("policy")) return { kind: "policy", label: "Policy denied" };
  if (type.includes("unfroze")) return { kind: "unfrozen", label: "Unfrozen" };
  if (type.includes("froze")) return { kind: "frozen", label: "Frozen" };
  const words = type.replace(/_/g, " ");
  return { kind: "other", label: words.charAt(0).toUpperCase() + words.slice(1) };
}
