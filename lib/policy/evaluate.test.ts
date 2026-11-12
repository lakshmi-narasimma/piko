import { describe, expect, it } from "vitest";
import {
  evaluatePolicies,
  parsePolicyDocument,
  policyDocumentToJson,
  type PolicyCallContext,
  type PolicyRecord,
} from "./index";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const TEAM = "00000000-0000-4000-8000-0000000000a1";
const AGENT = "00000000-0000-4000-8000-0000000000b1";

const context = (over: Partial<PolicyCallContext> = {}): PolicyCallContext => ({
  orgId: ORG,
  teamId: TEAM,
  agentId: AGENT,
  vendor: {
    sellerSlug: "datacorp",
    sellerName: "DataCorp",
    listingSlug: "cheap-reviews",
    listingName: "Cheap Reviews",
  },
  category: "reviews",
  priceMicro: 3_000n,
  ...over,
});

let n = 0;
const policy = (json: unknown, orgId = ORG): PolicyRecord => ({
  id: `policy-${++n}`,
  orgId,
  name: `Policy ${n}`,
  document: parsePolicyDocument(json),
});

const org = { org: true };

describe("parsePolicyDocument", () => {
  it("parses DESIGN.md's example, with amounts as bigint", () => {
    const document = parsePolicyDocument({
      scope: { team: "marketing" },
      rules: [
        { type: "budget", category: "search", period: "month", maxMicroUsd: 50000000 },
        { type: "approval_above", maxMicroUsd: 50000 },
      ],
    });
    expect(document.rules).toEqual([
      { type: "budget", category: "search", period: "month", maxMicroUsd: 50_000_000n },
      { type: "approval_above", maxMicroUsd: 50_000n },
    ]);
  });

  it("accepts amounts as digit strings and round-trips through the stored form", () => {
    const document = parsePolicyDocument({
      scope: org,
      rules: [{ type: "max_price_per_call", maxMicroUsd: "9007199254740993" }],
    });
    expect(document.rules[0]).toMatchObject({ maxMicroUsd: 9_007_199_254_740_993n });
    expect(parsePolicyDocument(policyDocumentToJson(document))).toEqual(document);
  });

  it.each([
    ["an unknown rule", { scope: org, rules: [{ type: "be_nice" }] }],
    ["no rules", { scope: org, rules: [] }],
    ["a dollar amount", { scope: org, rules: [{ type: "approval_above", maxMicroUsd: 0.05 }] }],
    ["a negative amount", { scope: org, rules: [{ type: "approval_above", maxMicroUsd: -1 }] }],
    [
      "two scopes",
      { scope: { team: "a", agent: "b" }, rules: [{ type: "vendor_block", vendors: ["x"] }] },
    ],
    ["an extra field", { scope: org, rules: [{ type: "vendor_block", vendors: ["x"], also: 1 }] }],
    ["an empty vendor list", { scope: org, rules: [{ type: "vendor_allow", vendors: [] }] }],
  ])("rejects %s", (_label, json) => {
    expect(() => parsePolicyDocument(json)).toThrow();
  });
});

describe("evaluatePolicies", () => {
  it("allows a payment no Policy covers", () => {
    expect(evaluatePolicies([], context())).toEqual({ outcome: "allow" });
  });

  it("vendor_block denies a blocked vendor by listing or seller name, ignoring case", () => {
    const byListing = policy({
      scope: org,
      rules: [{ type: "vendor_block", vendors: ["cheap reviews"] }],
    });
    expect(evaluatePolicies([byListing], context())).toMatchObject({
      outcome: "deny",
      policyId: byListing.id,
      policyName: byListing.name,
      rule: "vendor_block",
    });
    const bySeller = policy({
      scope: org,
      rules: [{ type: "vendor_block", vendors: ["DATACORP"] }],
    });
    expect(evaluatePolicies([bySeller], context()).outcome).toBe("deny");
    const other = policy({
      scope: org,
      rules: [{ type: "vendor_block", vendors: ["review-summariser"] }],
    });
    expect(evaluatePolicies([other], context())).toEqual({ outcome: "allow" });
  });

  it("vendor_allow denies every vendor not on the list", () => {
    const allow = policy({ scope: org, rules: [{ type: "vendor_allow", vendors: ["priya"] }] });
    expect(evaluatePolicies([allow], context())).toMatchObject({
      outcome: "deny",
      rule: "vendor_allow",
    });
    expect(
      evaluatePolicies([allow], context({ vendor: { ...context().vendor, sellerSlug: "priya" } })),
    ).toEqual({ outcome: "allow" });
  });

  it("max_price_per_call denies a price over the limit, not one at it", () => {
    const max = policy({ scope: org, rules: [{ type: "max_price_per_call", maxMicroUsd: 3000 }] });
    expect(evaluatePolicies([max], context({ priceMicro: 3_000n }))).toEqual({ outcome: "allow" });
    expect(evaluatePolicies([max], context({ priceMicro: 3_001n }))).toMatchObject({
      outcome: "deny",
      rule: "max_price_per_call",
      reason: "This call costs $0.003001, over the $0.003 per-call limit.",
    });
  });

  it("a category limits a price rule to that category", () => {
    const search = policy({
      scope: org,
      rules: [{ type: "max_price_per_call", maxMicroUsd: 1000, category: "Search" }],
    });
    expect(evaluatePolicies([search], context())).toEqual({ outcome: "allow" });
    expect(evaluatePolicies([search], context({ category: "search" })).outcome).toBe("deny");
    expect(evaluatePolicies([search], context({ category: null }))).toEqual({ outcome: "allow" });
  });

  it("approval_above asks for approval over the threshold", () => {
    const approval = policy({ scope: org, rules: [{ type: "approval_above", maxMicroUsd: 2000 }] });
    expect(evaluatePolicies([approval], context())).toEqual({
      outcome: "needs_approval",
      policyId: approval.id,
      policyName: approval.name,
      thresholdMicro: 2_000n,
    });
    expect(evaluatePolicies([approval], context({ priceMicro: 2_000n }))).toEqual({
      outcome: "allow",
    });
  });

  it("ignores budget rules, which lib/budgets enforces", () => {
    const budget = policy({
      scope: org,
      rules: [{ type: "budget", period: "day", maxMicroUsd: 1 }],
    });
    expect(evaluatePolicies([budget], context())).toEqual({ outcome: "allow" });
  });

  it("runs the checks in DESIGN.md's order across all Policies: vendor, then price, then approval", () => {
    const approval = policy({ scope: org, rules: [{ type: "approval_above", maxMicroUsd: 0 }] });
    const max = policy({ scope: org, rules: [{ type: "max_price_per_call", maxMicroUsd: 0 }] });
    const block = policy({
      scope: org,
      rules: [{ type: "vendor_block", vendors: ["Cheap Reviews"] }],
    });
    expect(evaluatePolicies([approval, max, block], context())).toMatchObject({
      policyId: block.id,
      rule: "vendor_block",
    });
    expect(evaluatePolicies([approval, max], context())).toMatchObject({
      policyId: max.id,
      rule: "max_price_per_call",
    });
  });

  it("applies the org's, the team's and the Agent's Policies, and no one else's", () => {
    const block = { rules: [{ type: "vendor_block", vendors: ["Cheap Reviews"] }] };
    const forTeam = policy({ scope: { team: TEAM }, ...block });
    const forAgent = policy({ scope: { agent: AGENT }, ...block });
    const otherTeam = policy({ scope: { team: "someone-else" }, ...block });
    const otherAgent = policy({ scope: { agent: "someone-else" }, ...block });
    const otherOrg = policy({ scope: org, ...block }, OTHER_ORG);

    expect(evaluatePolicies([forTeam], context()).outcome).toBe("deny");
    expect(evaluatePolicies([forTeam], context({ teamId: null }))).toEqual({ outcome: "allow" });
    expect(evaluatePolicies([forAgent], context()).outcome).toBe("deny");
    expect(evaluatePolicies([otherTeam, otherAgent, otherOrg], context())).toEqual({
      outcome: "allow",
    });
  });

  it("combines Policies: a deny from one wins over another's approval", () => {
    const approval = policy({
      scope: { team: TEAM },
      rules: [{ type: "approval_above", maxMicroUsd: 0 }],
    });
    const allow = policy({ scope: org, rules: [{ type: "vendor_allow", vendors: ["priya"] }] });
    expect(evaluatePolicies([approval, allow], context())).toMatchObject({
      outcome: "deny",
      policyId: allow.id,
    });
  });
});
