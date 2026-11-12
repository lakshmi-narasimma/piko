import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createSeller,
  gatewayRequest,
  startStubUpstream,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
  type StubUpstream,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, calls, challenges, ledgerEntries, orgs, teams } from "../db/schema";
import { handleSettleRequest, handleVerifyRequest } from "../facilitator";
import { createKey } from "../keys";
import { availableFunds, balanceOf } from "../ledger";
import { setFrozen, type FreezeTarget } from "../org/freeze";
import type { Actor } from "../org";
import { handlePayRequest, type IssuedReceipt } from "../pay";
import { decodeHeaderValue, type PaymentPayload, type PaymentRequired } from "../x402";
import { handleGatewayRequest } from "./index";

const url = inject("testDatabaseUrl");
const FUNDED = 10_000n;

describe.skipIf(!url)("kill switch: the gateway refuses a frozen agent, team or org", () => {
  let db: Db;
  let upstream: StubUpstream;

  beforeAll(async () => {
    stubGatewayEnv();
    db = createDb(url!, { max: 5 });
    upstream = await startStubUpstream();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await upstream.close();
    await db.$client.end();
  });

  type Seller = Awaited<ReturnType<typeof createSeller>>;

  /** A funded prepaid company with two agents in a Marketing team, each with a Key. */
  async function newBuyerOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Acme", slug: `acme-${randomUUID()}`, kind: "company", billing: "prepaid" })
      .returning({ id: orgs.id });
    const orgId = org!.id;
    const [team] = await db
      .insert(teams)
      .values({ orgId, name: "Marketing" })
      .returning({ id: teams.id });
    const made = await db
      .insert(agents)
      .values([
        { orgId, teamId: team!.id, name: "campaign-researcher" },
        { orgId, teamId: team!.id, name: "competitor-watch" },
      ])
      .returning({ id: agents.id });
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId,
      amountMicro: FUNDED,
      reason: "seed",
      refId: randomUUID(),
    });
    const keys = await Promise.all(made.map((agent) => createKey(db, agent.id)));
    const admin: Actor = { org: { id: orgId }, role: "admin" };
    return {
      orgId,
      teamId: team!.id,
      agentIds: made.map((agent) => agent.id),
      keys: keys.map((key) => key.rawKey),
      admin,
    };
  }

  function call(
    seller: Seller,
    init: { key?: string; signature?: string; autopay?: boolean } = {},
  ) {
    const headers: Record<string, string> = {};
    if (init.signature) headers["PAYMENT-SIGNATURE"] = init.signature;
    if (init.autopay) headers["X-Piko-Autopay"] = "true";
    return handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${seller.slug}${seller.path}`, {
        key: init.key,
        headers,
      }),
      { seller: seller.slug, path: seller.path.slice(1).split("/") },
    );
  }

  const pay = (key: string, nonce: string) =>
    handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ nonce }),
      }),
    );

  /** A 402 with no Key, then POST /api/pay: a Receipt the agent now holds. */
  async function receipt(seller: Seller, key: string) {
    const { accepts } = (await (await call(seller)).json()) as PaymentRequired;
    const nonce = accepts[0]!.extra.nonce;
    const res = await pay(key, nonce);
    expect(res.status).toBe(200);
    return { nonce, issued: (await res.json()) as IssuedReceipt, requirements: accepts[0]! };
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: { code: string; scope?: string } }).error;

  async function expectFrozen(res: Response, scope: string) {
    expect(res.status).toBe(423);
    expect(await errorOf(res)).toMatchObject({ code: "agent_frozen", scope });
  }

  /** The hold is gone, nothing was charged and the Receipt can never be used again. */
  async function expectReleased(orgId: string, nonce: string) {
    expect(await availableFunds(db, orgId)).toBe(FUNDED);
    expect(await balanceOf(db, { type: "wallet", orgId })).toBe(FUNDED);
    expect(await db.select().from(calls).where(eq(calls.nonce, nonce))).toEqual([]);
    const [challenge] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(challenge!.consumedAt).toBeNull();
    expect(challenge!.reservationExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  }

  const freeze = (org: { admin: Actor }, target: FreezeTarget, frozen = true) =>
    setFrozen(db, org.admin, target, frozen);

  it.each([
    [
      "agent",
      (org: Awaited<ReturnType<typeof newBuyerOrg>>) => ({
        scope: "agent" as const,
        id: org.agentIds[0],
      }),
    ],
    [
      "team",
      (org: Awaited<ReturnType<typeof newBuyerOrg>>) => ({
        scope: "team" as const,
        id: org.teamId,
      }),
    ],
    ["org", () => ({ scope: "org" as const })],
  ])(
    "a Receipt issued before a %s freeze gets 423, is not forwarded, charges nothing and frees the hold",
    async (scope, targetOf) => {
      const seller = await createSeller(db, upstream.url);
      const org = await newBuyerOrg();
      const { nonce, issued } = await receipt(seller, org.keys[0]!);
      expect(await availableFunds(db, org.orgId)).toBe(FUNDED - 2_000n);

      await freeze(org, targetOf(org));
      const before = upstream.requests.length;
      await expectFrozen(await call(seller, { signature: issued.paymentSignature }), scope);

      expect(upstream.requests.length).toBe(before);
      await expectReleased(org.orgId, nonce);

      // Unfreezing doesn't revive the released Receipt: the agent asks for a new 402.
      await freeze(org, targetOf(org), false);
      expect((await call(seller, { signature: issued.paymentSignature })).status).toBe(410);
    },
  );

  it("freezing the team blocks both its agents on every path, and unfreezing restores them", async () => {
    const seller = await createSeller(db, upstream.url);
    const free = await createSeller(db, upstream.url, { freeQuota: 5 });
    const zero = await createSeller(db, upstream.url, { priceMicro: 0n });
    const org = await newBuyerOrg();
    // A Challenge that was issued but not yet paid when the freeze lands.
    const { accepts } = (await (await call(seller)).json()) as PaymentRequired;
    const nonce = accepts[0]!.extra.nonce;

    await freeze(org, { scope: "team", id: org.teamId });

    for (const key of org.keys) {
      await expectFrozen(await pay(key, nonce), "team");
      await expectFrozen(await call(seller, { key }), "team");
      await expectFrozen(await call(seller, { key, autopay: true }), "team");
      await expectFrozen(await call(free, { key }), "team");
      await expectFrozen(await call(zero, { key }), "team");
    }
    expect(await db.select().from(calls).where(eq(calls.buyerOrgId, org.orgId))).toEqual([]);

    await freeze(org, { scope: "team", id: org.teamId }, false);
    for (const key of org.keys) {
      expect((await call(seller, { key, autopay: true })).status).toBe(200);
      expect((await call(free, { key })).status).toBe(200);
      expect((await call(zero, { key })).status).toBe(200);
    }
  });

  it("an org-wide freeze blocks every agent of that org and no other org's", async () => {
    const seller = await createSeller(db, upstream.url);
    const acme = await newBuyerOrg();
    const other = await newBuyerOrg();
    const otherHeld = await receipt(seller, other.keys[0]!);

    await freeze(acme, { scope: "org" });

    for (const key of acme.keys) {
      await expectFrozen(await call(seller, { key, autopay: true }), "org");
    }
    for (const key of other.keys) {
      expect((await call(seller, { key, autopay: true })).status).toBe(200);
    }
    expect((await call(seller, { signature: otherHeld.issued.paymentSignature })).status).toBe(200);
  });

  it("the facilitator refuses a frozen agent's Receipt: verify is invalid, settle frees the hold", async () => {
    const seller = await createSeller(db, upstream.url);
    const org = await newBuyerOrg();
    const { nonce, issued, requirements } = await receipt(seller, org.keys[1]!);
    await freeze(org, { scope: "agent", id: org.agentIds[1] });

    const body = JSON.stringify({
      x402Version: 2,
      paymentPayload: decodeHeaderValue(issued.paymentSignature) as PaymentPayload,
      paymentRequirements: requirements,
    });
    const post = () => new Request("https://piko.test/api/facilitator/x", { method: "POST", body });

    const verified = await handleVerifyRequest({ db, config }, post());
    await expect(verified.json()).resolves.toMatchObject({
      isValid: false,
      invalidReason: "agent_frozen",
    });
    // Verify is read-only: the hold is still there.
    expect(await availableFunds(db, org.orgId)).toBe(FUNDED - 2_000n);

    const settled = await handleSettleRequest({ db, config }, post());
    expect(settled.status).toBe(423);
    await expect(settled.json()).resolves.toMatchObject({
      success: false,
      errorReason: "agent_frozen",
    });
    await expectReleased(org.orgId, nonce);
  });
});
