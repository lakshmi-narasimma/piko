/** An org's saved Policies in plain English, for the Org console. Read-only: no editing. */
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { agents, policies, teams } from "../db/schema";
import { describePolicy } from "./describe";
import { parsePolicyDocument } from "./schema";

export interface PolicySummary {
  id: string;
  /** What the admin typed. */
  sourceText: string;
  readable: string[];
  /** Saved but not confirmed policies aren't enforced. */
  status: "enforced" | "not_enforced";
  createdAt: Date;
}

export async function listPolicies(db: Db, orgId: string): Promise<PolicySummary[]> {
  const [rows, teamRows, agentRows] = await Promise.all([
    db
      .select()
      .from(policies)
      .where(eq(policies.orgId, orgId))
      .orderBy(desc(policies.createdAt))
      .limit(50),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.orgId, orgId)),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId)),
  ]);
  const names = new Map([...teamRows, ...agentRows].map((r) => [r.id, r.name]));
  return rows.map((row) => {
    let readable: string[];
    try {
      const document = parsePolicyDocument(row.compiledJson);
      const { scope } = document;
      const ref = "org" in scope ? undefined : "team" in scope ? scope.team : scope.agent;
      readable = describePolicy(document, { scope: ref ? names.get(ref) : undefined });
    } catch {
      readable = ["This stored policy can't be read."];
    }
    return {
      id: row.id,
      sourceText: row.sourceText,
      readable,
      status: row.confirmedAt ? "enforced" : "not_enforced",
      createdAt: row.createdAt,
    };
  });
}
