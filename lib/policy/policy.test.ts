import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { POLICY_ALERT_TYPE } from "../alerts";
import { createDb, type Db } from "../db/client";
import { agents, alerts, budgets, challenges, listings, teams } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { availableFunds } from "../ledger";
import { handlePayRequest } from "../pay";
import type { PaymentRequired } from "../x402";
import { confirmPolicy, createPolicy, loadPolicies, PolicyError } from "./index";

const url = inject("testDatabaseUrl");
const UPSTREAM = "http://127.0.0.1:1";

describe.skipIf(!url)("Policies", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** A funded buyer whose Agent is in a team. */
  async function buyer() {
    const b = await createBuyer(db, 1_000_000n);
    const [team] = await db
      .insert(teams)
      .values({ orgId: b.orgId, name: "Marketing" })
      .returning({ id: teams.id });
    await db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, b.agentId));
    return { ...b, teamId: team!.id };
  }

  /** A seller whose Listing is called Cheap Reviews. */
  async function cheapReviews(priceMicro = 3_000n) {
    const seller = await createSeller(db, UPSTREAM, { priceMicro });
    await db
      .update(listings)
      .set({ name: "Cheap Reviews", category: "reviews" })
      .where(eq(listings.sellerOrgId, seller.orgId));
    return seller;
  }

  async function challenge(seller: { slug: string }, key: string) {
    const res = await handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, { key }),
      { seller: seller.slug, path: ["history"] },
    );
    expect(res.status).toBe(402);
    return ((await res.json()) as PaymentRequired).accepts[0]!.extra.nonce;
  }

  function pay(key: string, nonce: string) {
    return handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce }),
      }),
    );
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: Record<string, unknown> }).error;

  const BLOCK = "Nobody at Acme may use the 'Cheap Reviews' API.";
  const blockCheapReviews = (orgId: string, confirmed = true) =>
    createPolicy(db, {
      orgId,
      sourceText: BLOCK,
      document: {
        scope: { org: true },
        rules: [{ type: "vendor_block", vendors: ["Cheap Reviews"] }],
      },
      confirmed,
    });

  it("F5 vendor block: a call to Cheap Reviews is 403 policy_denied, naming the policy", async () => {
    const b = await buyer();
    const policy = await blockCheapReviews(b.orgId);
    const seller = await cheapReviews();

    const res = await pay(b.rawKey, await challenge(seller, b.rawKey));

    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error).toMatchObject({
      code: "policy_denied",
      policyId: policy.id,
      rule: "vendor_block",
      policy: BLOCK,
    });
    expect(error.message).toContain(BLOCK);
    expect(await availableFunds(db, b.orgId)).toBe(1_000_000n);

    const written = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.agentId, b.agentId), eq(alerts.type, POLICY_ALERT_TYPE)));
    expect(written).toHaveLength(1);
    expect(written[0]!.message).toContain(BLOCK);
  });

  it("F5 vendor block through autopay: 403 policy_denied and nothing forwarded or held", async () => {
    const b = await buyer();
    await blockCheapReviews(b.orgId);
    const seller = await cheapReviews();

    const res = await handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}/history`, {
        key: b.rawKey,
        headers: { "X-Piko-Autopay": "true" },
      }),
      { seller: seller.slug, path: ["history"] },
    );

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "policy_denied", rule: "vendor_block" });
    const held = await db.select().from(challenges).where(eq(challenges.agentId, b.agentId));
    expect(held.every((c) => c.reservedAt === null)).toBe(true);
  });

  it("writes one alert for repeated denials of the same Agent", async () => {
    const b = await buyer();
    await blockCheapReviews(b.orgId);
    const seller = await cheapReviews();
    for (let i = 0; i < 3; i++) {
      expect((await pay(b.rawKey, await challenge(seller, b.rawKey))).status).toBe(403);
    }
    const written = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.agentId, b.agentId), eq(alerts.type, POLICY_ALERT_TYPE)));
    expect(written).toHaveLength(1);
  });

  it("does not enforce a Policy until it is confirmed", async () => {
    const b = await buyer();
    const policy = await blockCheapReviews(b.orgId, false);
    const seller = await cheapReviews();
    expect(await loadPolicies(db, b.orgId)).toEqual([]);
    expect((await pay(b.rawKey, await challenge(seller, b.rawKey))).status).toBe(200);

    await confirmPolicy(db, { orgId: b.orgId, policyId: policy.id });
    expect((await pay(b.rawKey, await challenge(seller, b.rawKey))).status).toBe(403);
  });

  it("never applies another org's Policy", async () => {
    const other = await buyer();
    await blockCheapReviews(other.orgId);
    const b = await buyer();
    const seller = await cheapReviews();
    expect((await pay(b.rawKey, await challenge(seller, b.rawKey))).status).toBe(200);
  });

  it("denies a price over a team's per-call limit", async () => {
    const b = await buyer();
    await createPolicy(db, {
      orgId: b.orgId,
      sourceText: "Marketing never pays more than $0.002 a call.",
      document: {
        scope: { team: "Marketing" },
        rules: [{ type: "max_price_per_call", maxMicroUsd: 2000 }],
      },
      confirmed: true,
    });
    const seller = await cheapReviews(3_000n);
    const res = await pay(b.rawKey, await challenge(seller, b.rawKey));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "policy_denied", rule: "max_price_per_call" });
  });

  it("denies a payment over an approval threshold until approvals exist (P5-04)", async () => {
    const b = await buyer();
    await createPolicy(db, {
      orgId: b.orgId,
      sourceText: "Anything over a tenth of a cent needs my OK.",
      document: {
        scope: { agent: b.agentId },
        rules: [{ type: "approval_above", maxMicroUsd: 1000 }],
      },
      confirmed: true,
    });
    const seller = await cheapReviews(3_000n);
    const res = await pay(b.rawKey, await challenge(seller, b.rawKey));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "policy_denied", rule: "approval_above" });
  });

  it("stores the scope as an id and turns budget rules into Budgets on confirm", async () => {
    const b = await buyer();
    const policy = await createPolicy(db, {
      orgId: b.orgId,
      sourceText: "Marketing agents can't spend more than $50 a month on search.",
      document: {
        scope: { team: "Marketing" },
        rules: [{ type: "budget", category: "search", period: "month", maxMicroUsd: 50_000_000 }],
      },
    });
    expect(policy.document.scope).toEqual({ team: b.teamId });
    expect(await db.select().from(budgets).where(eq(budgets.orgId, b.orgId))).toEqual([]);

    await confirmPolicy(db, { orgId: b.orgId, policyId: policy.id });
    await confirmPolicy(db, { orgId: b.orgId, policyId: policy.id });

    const rows = await db.select().from(budgets).where(eq(budgets.orgId, b.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopeType: "team",
      scopeId: b.teamId,
      period: "month",
      maxMicro: 50_000_000n,
      category: "search",
    });
    const [loaded] = await loadPolicies(db, b.orgId);
    expect(loaded).toEqual(policy);
  });

  it("rejects an invalid document, an unknown team and another org's Policy", async () => {
    const b = await buyer();
    await expect(
      createPolicy(db, { orgId: b.orgId, sourceText: "make it cheaper somehow", document: {} }),
    ).rejects.toMatchObject({ code: "invalid_policy" });
    await expect(
      createPolicy(db, {
        orgId: b.orgId,
        sourceText: "Support can't use Cheap Reviews.",
        document: { scope: { team: "Support" }, rules: [{ type: "vendor_block", vendors: ["x"] }] },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
    const other = await buyer();
    const policy = await blockCheapReviews(other.orgId, false);
    await expect(confirmPolicy(db, { orgId: b.orgId, policyId: policy.id })).rejects.toMatchObject({
      code: "policy_not_found",
    });
    await expect(
      confirmPolicy(db, { orgId: b.orgId, policyId: randomUUID() }),
    ).rejects.toMatchObject({ code: "policy_not_found" });
  });
});
