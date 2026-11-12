/**
 * Deterministic Policy checks that run before money moves (docs/DESIGN.md section 9). Gemini
 * only compiles plain English into a Policy document (P5-05) that an admin confirms; this
 * module stores, loads and enforces it. A Policy is enforced only once `confirmed_at` is set.
 */
import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { createBudget } from "../budgets";
import type { Db } from "../db/client";
import { agents, policies, teams } from "../db/schema";
import type { DbOrTx } from "../ledger";
import type { PolicyRecord } from "./evaluate";
import {
  parsePolicyDocument,
  policyDocumentSchema,
  policyDocumentToJson,
  type PolicyDocument,
  type PolicyScope,
} from "./schema";

export * from "./describe";
export * from "./evaluate";
export * from "./schema";

export class PolicyError extends Error {
  constructor(
    public readonly code: "scope_not_found" | "policy_not_found" | "invalid_policy",
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turns a team or Agent named by id or name into its id, within the org. */
async function resolveScope(db: DbOrTx, orgId: string, scope: PolicyScope): Promise<PolicyScope> {
  if ("org" in scope) return scope;
  const kind = "team" in scope ? "team" : "agent";
  const ref = "team" in scope ? scope.team : scope.agent;
  const table = kind === "team" ? teams : agents;
  const byRef = UUID.test(ref) ? or(eq(table.id, ref), eq(table.name, ref)) : eq(table.name, ref);
  const where = and(eq(table.orgId, orgId), byRef);
  const rows =
    kind === "team"
      ? await db.select({ id: teams.id }).from(teams).where(where).limit(2)
      : await db.select({ id: agents.id }).from(agents).where(where).limit(2);
  if (rows.length !== 1) {
    const problem =
      rows.length === 0
        ? `No ${kind} "${ref}" in this org.`
        : `More than one ${kind} is called "${ref}".`;
    throw new PolicyError("scope_not_found", problem);
  }
  return kind === "team" ? { team: rows[0]!.id } : { agent: rows[0]!.id };
}

/** Turns the Policy's budget rules into Budgets on its scope. */
async function createBudgets(db: DbOrTx, orgId: string, document: PolicyDocument): Promise<void> {
  const { scope } = document;
  const [scopeType, scopeId] =
    "org" in scope
      ? (["org", orgId] as const)
      : "team" in scope
        ? (["team", scope.team] as const)
        : (["agent", scope.agent] as const);
  for (const rule of document.rules) {
    if (rule.type !== "budget") continue;
    await createBudget(db, {
      orgId,
      scopeType,
      scopeId,
      period: rule.period,
      maxMicro: rule.maxMicroUsd,
      category: rule.category ?? null,
    });
  }
}

export interface NewPolicy {
  orgId: string;
  /** What the admin typed. */
  sourceText: string;
  /** The compiled document, checked against the schema here. */
  document: unknown;
  /** Enforce it now. Otherwise it waits for {@link confirmPolicy}. */
  confirmed?: boolean;
}

/**
 * Saves a Policy with its scope resolved to ids. When `confirmed`, it takes effect at once
 * and its budget rules become Budgets, all in one transaction.
 *
 * @throws PolicyError `invalid_policy` or `scope_not_found`.
 */
export async function createPolicy(db: Db, input: NewPolicy): Promise<PolicyRecord> {
  const parsed = checkDocument(input.document);
  return db.transaction(async (tx) => {
    const document = { ...parsed, scope: await resolveScope(tx, input.orgId, parsed.scope) };
    const [row] = await tx
      .insert(policies)
      .values({
        orgId: input.orgId,
        sourceText: input.sourceText,
        compiledJson: policyDocumentToJson(document),
        confirmedAt: input.confirmed ? new Date() : null,
      })
      .returning({ id: policies.id });
    if (input.confirmed) await createBudgets(tx, input.orgId, document);
    return { id: row!.id, orgId: input.orgId, name: input.sourceText, document };
  });
}

/**
 * Puts a saved Policy into effect and turns its budget rules into Budgets. Confirming one
 * that is already confirmed changes nothing.
 *
 * @throws PolicyError `policy_not_found`.
 */
export async function confirmPolicy(
  db: Db,
  input: { orgId: string; policyId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(policies)
      .where(and(eq(policies.id, input.policyId), eq(policies.orgId, input.orgId)))
      .for("update");
    if (!row) throw new PolicyError("policy_not_found", "No such policy in this org.");
    if (row.confirmedAt) return;
    await tx.update(policies).set({ confirmedAt: new Date() }).where(eq(policies.id, row.id));
    await createBudgets(tx, row.orgId, parsePolicyDocument(row.compiledJson));
  });
}

/**
 * An org's confirmed Policies, oldest first. A stored document that no longer parses throws:
 * enforcement fails closed rather than skip a Policy.
 */
export async function loadPolicies(db: DbOrTx, orgId: string): Promise<PolicyRecord[]> {
  const rows = await db
    .select()
    .from(policies)
    .where(and(eq(policies.orgId, orgId), isNotNull(policies.confirmedAt)))
    .orderBy(asc(policies.createdAt), asc(policies.id));
  return rows.map((row) => ({
    id: row.id,
    orgId: row.orgId,
    name: row.sourceText,
    document: parsePolicyDocument(row.compiledJson),
  }));
}

function checkDocument(json: unknown): PolicyDocument {
  const result = policyDocumentSchema.safeParse(json);
  if (!result.success) {
    throw new PolicyError(
      "invalid_policy",
      `This isn't a valid policy. ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
