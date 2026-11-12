/**
 * The Policy document (docs/DESIGN.md section 9): what `policies.compiled_json` holds and what
 * the P5-05 compiler must produce. Amounts are integer micro-USD. JSON carries them as a whole
 * number or a string of digits; parsing turns them into `bigint`.
 *
 * ```json
 * { "scope": { "team": "marketing" },
 *   "rules": [
 *     { "type": "budget", "category": "search", "period": "month", "maxMicroUsd": 50000000 },
 *     { "type": "approval_above", "maxMicroUsd": 50000 }
 *   ] }
 * ```
 */
import { z } from "zod";

/** A non-negative whole number of micro-USD, as a JSON number or a string of digits. */
const microUsd = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d{1,18}$/, "must be a whole number of micro-USD"),
  ])
  .transform((value) => BigInt(value));

const name = z.string().trim().min(1).max(200);

/**
 * Who a Policy applies to: the whole org, one team, or one Agent. A team or Agent is named by
 * its id or its name; createPolicy stores the id.
 */
export const policyScopeSchema = z.union([
  z.strictObject({ org: z.literal(true) }),
  z.strictObject({ team: name }),
  z.strictObject({ agent: name }),
]);

/** Vendors are matched, ignoring case, against a Listing's slug or name or its seller's. */
const vendors = z.array(name).min(1).max(100);

export const policyRuleSchema = z.discriminatedUnion("type", [
  /** Never pay these vendors. */
  z.strictObject({ type: z.literal("vendor_block"), vendors }),
  /** Pay only these vendors. */
  z.strictObject({ type: z.literal("vendor_allow"), vendors }),
  /** Never pay more than this for one Call (optionally only in one Listing category). */
  z.strictObject({
    type: z.literal("max_price_per_call"),
    maxMicroUsd: microUsd,
    category: name.optional(),
  }),
  /** A Call priced above this needs a human's approval (P5-04). */
  z.strictObject({
    type: z.literal("approval_above"),
    maxMicroUsd: microUsd,
    category: name.optional(),
  }),
  /** A spending cap. Confirming the Policy turns it into a Budget (lib/budgets). */
  z.strictObject({
    type: z.literal("budget"),
    period: z.enum(["day", "month", "task"]),
    maxMicroUsd: microUsd,
    category: name.optional(),
  }),
]);

export const policyDocumentSchema = z.strictObject({
  scope: policyScopeSchema,
  rules: z.array(policyRuleSchema).min(1).max(50),
});

export type PolicyScope = z.output<typeof policyScopeSchema>;
export type PolicyRule = z.output<typeof policyRuleSchema>;
export type PolicyRuleType = PolicyRule["type"];
export type PolicyDocument = z.output<typeof policyDocumentSchema>;
/** The JSON form, before amounts become `bigint`: what Gemini returns and the table stores. */
export type PolicyDocumentJson = z.input<typeof policyDocumentSchema>;

/** Checks a document and returns it with `bigint` amounts. Throws a ZodError if it's invalid. */
export function parsePolicyDocument(json: unknown): PolicyDocument {
  return policyDocumentSchema.parse(json);
}

/** The stored JSON form of a parsed document: amounts become strings of digits. */
export function policyDocumentToJson(document: PolicyDocument): PolicyDocumentJson {
  return {
    scope: document.scope,
    rules: document.rules.map((rule) =>
      "maxMicroUsd" in rule ? { ...rule, maxMicroUsd: rule.maxMicroUsd.toString() } : rule,
    ),
  };
}
