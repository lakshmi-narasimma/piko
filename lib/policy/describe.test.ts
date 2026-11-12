import { describe, expect, it } from "vitest";
import { describePolicy } from "./describe";
import { parsePolicyDocument } from "./schema";

const doc = (scope: unknown, ...rules: unknown[]) => parsePolicyDocument({ scope, rules });

describe("describePolicy", () => {
  it("describes the scope", () => {
    const rule = { type: "vendor_block", vendors: ["x"] };
    expect(describePolicy(doc({ org: true }, rule))[0]).toBe("Applies to: the whole org");
    expect(describePolicy(doc({ team: "Support" }, rule))[0]).toBe("Applies to: the Support team");
    expect(describePolicy(doc({ agent: "loop-bot" }, rule))[0]).toBe(
      "Applies to: the agent loop-bot",
    );
  });

  it("names a team or Agent by its label when the scope holds an id", () => {
    const rule = { type: "vendor_block", vendors: ["x"] };
    expect(describePolicy(doc({ team: "0c1d" }, rule), { scope: "Marketing" })[0]).toBe(
      "Applies to: the Marketing team",
    );
  });

  it("describes a budget in dollars for each period, with a category", () => {
    const lines = describePolicy(
      doc(
        { team: "Support" },
        { type: "budget", period: "day", maxMicroUsd: 10_000_000 },
        { type: "budget", period: "month", maxMicroUsd: "50000000", category: "search" },
        { type: "budget", period: "task", maxMicroUsd: 1_000_000 },
      ),
    );
    expect(lines.slice(1)).toEqual([
      "Blocks spending above $10.00 per day",
      "Blocks spending above $50.00 per month on search",
      "Blocks spending above $1.00 per task",
    ]);
  });

  it("describes vendor rules", () => {
    const lines = describePolicy(
      doc(
        { org: true },
        { type: "vendor_block", vendors: ["Cheap Reviews"] },
        { type: "vendor_allow", vendors: ["Product Search", "Price History"] },
      ),
    );
    expect(lines.slice(1)).toEqual([
      "Blocks calls to Cheap Reviews",
      "Only allows calls to Product Search, Price History",
    ]);
  });

  it("describes a price cap per call", () => {
    const lines = describePolicy(
      doc(
        { org: true },
        { type: "max_price_per_call", maxMicroUsd: 50_000 },
        { type: "max_price_per_call", maxMicroUsd: 5_000, category: "reviews" },
      ),
    );
    expect(lines.slice(1)).toEqual([
      "Blocks any single call priced above $0.05",
      "Blocks any single call priced above $0.005 in the reviews category",
    ]);
  });

  it("says approvals aren't live yet", () => {
    const [, line] = describePolicy(
      doc({ team: "Marketing" }, { type: "approval_above", maxMicroUsd: 50_000 }),
    );
    expect(line).toBe(
      "Calls over $0.05 need approval. Note: approvals aren't live yet, so these calls will be blocked",
    );
  });
});
