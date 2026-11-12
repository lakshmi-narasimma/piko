import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { agents, challenges, ledgerEntries, teams } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { createKey } from "../keys";
import { availableFunds } from "../ledger";
import { decodeHeaderValue, type PaymentPayload, type PaymentRequired } from "../x402";
import { verifyReceipt } from "../x402/receipt";
import { handlePayRequest, PAY_STEPS, type IssuedReceipt } from "./index";

const url = inject("testDatabaseUrl");

const PRICE = 2_000n;
const UPSTREAM = "http://127.0.0.1:1";

describe.skipIf(!url)("POST /api/pay", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** Issues a real Challenge through the gateway. */
  async function challenge(buyerKey?: string, priceMicro: bigint = PRICE) {
    const seller = await createSeller(db, UPSTREAM, { priceMicro });
    const request = new Request(`https://piko.test/g/${seller.slug}/history`, {
      headers: buyerKey ? { authorization: `Bearer ${buyerKey}` } : {},
    });
    const res = await handleGatewayRequest({ db, config }, request, {
      seller: seller.slug,
      path: ["history"],
    });
    const paymentRequired = (await res.json()) as PaymentRequired;
    return { seller, paymentRequired, nonce: paymentRequired.accepts[0]!.extra.nonce };
  }

  function pay(key: string | undefined, body: unknown) {
    return handlePayRequest(
      { db, config },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  const errorOf = async (res: Response) => ((await res.json()) as { error: object }).error;

  it("runs the steps in DESIGN.md section 9's order", () => {
    expect(PAY_STEPS.map((step) => step.name)).toEqual([
      "key",
      "frozen",
      "challenge",
      "breaker",
      "policy",
      "budget",
      "funds",
      "breaker-recount",
      "receipt",
    ]);
  });

  it("issues a Receipt and reserves the amount for a good payment", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { seller, paymentRequired, nonce } = await challenge();

    const res = await pay(buyer.rawKey, { nonce });

    expect(res.status).toBe(200);
    const issued = (await res.json()) as IssuedReceipt;
    expect(issued.amount).toBe("2000");

    const verification = verifyReceipt(issued.receipt, config.receiptSigningSecret);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.claims).toMatchObject({
        nonce,
        agentId: buyer.agentId,
        orgId: buyer.orgId,
        sellerId: seller.orgId,
        endpointId: seller.endpointId,
        amount: "2000",
      });
      const secondsLeft = verification.claims.exp - Date.now() / 1000;
      expect(secondsLeft).toBeGreaterThan(50);
      expect(secondsLeft).toBeLessThanOrEqual(60);
      expect(issued.expiresAt).toBe(new Date(verification.claims.exp * 1000).toISOString());
    }

    const payload = decodeHeaderValue(issued.paymentSignature) as PaymentPayload;
    expect(payload).toEqual({
      x402Version: 2,
      resource: { url: `https://piko.test/g/${seller.slug}/history` },
      accepted: paymentRequired.accepts[0],
      payload: { receipt: issued.receipt },
    });

    const [stored] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(stored).toMatchObject({ agentId: buyer.agentId, buyerOrgId: buyer.orgId });
    expect(stored!.reservedAt).not.toBeNull();
    expect(stored!.consumedAt).toBeNull();

    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);
    const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, nonce));
    expect(ledger).toHaveLength(0);
  });

  it("returns 410 challenge_expired for an expired Challenge", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();
    await db
      .update(challenges)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(challenges.nonce, nonce));

    const res = await pay(buyer.rawKey, { nonce });

    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_expired" });
    expect(await availableFunds(db, buyer.orgId)).toBe(10_000n);
  });

  it("returns 410 for a Challenge that was already used", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();
    await db.update(challenges).set({ consumedAt: new Date() }).where(eq(challenges.nonce, nonce));

    const res = await pay(buyer.rawKey, { nonce });

    expect(res.status).toBe(410);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_expired" });
  });

  it("gives the same agent the same Receipt when it retries, and holds the amount once", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();

    const first = await pay(buyer.rawKey, { nonce });
    expect(first.status).toBe(200);
    const second = await pay(buyer.rawKey, { nonce });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);
  });

  it("returns 410 when another agent of the same org pays a held Challenge", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();
    const [secondAgent] = await db
      .insert(agents)
      .values({ orgId: buyer.orgId, name: "second-agent" })
      .returning({ id: agents.id });
    const key = await createKey(db, secondAgent!.id);

    expect((await pay(buyer.rawKey, { nonce })).status).toBe(200);
    const second = await pay(key.rawKey, { nonce });

    expect(second.status).toBe(410);
    expect(await errorOf(second)).toMatchObject({ code: "challenge_expired" });
    expect(await availableFunds(db, buyer.orgId)).toBe(8_000n);
  });

  it("returns 403 when another buyer pays a Challenge someone else holds", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const other = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();

    expect((await pay(buyer.rawKey, { nonce })).status).toBe(200);
    const res = await pay(other.rawKey, { nonce });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_buyer_mismatch" });
    expect(await availableFunds(db, other.orgId)).toBe(10_000n);
  });

  it("checks the buyer under the lock too, when two buyers race for one Challenge", async () => {
    const first = await createBuyer(db, 10_000n);
    const second = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();

    const results = await Promise.all([
      pay(first.rawKey, { nonce }),
      pay(second.rawKey, { nonce }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 403]);
    const funds = [await availableFunds(db, first.orgId), await availableFunds(db, second.orgId)];
    expect(funds.map(String).sort()).toEqual(["10000", "8000"]);
  });

  it("answers an unexpected failure with 500 internal_error and no details", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...config, receiptSigningSecret: undefined as unknown as string };

    const res = await handlePayRequest(
      { db, config: broken },
      new Request("https://piko.test/api/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${buyer.rawKey}` },
        body: JSON.stringify({ nonce }),
      }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.code).toBe("internal_error");
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("returns 402 insufficient_funds for an empty wallet", async () => {
    const buyer = await createBuyer(db);
    const { nonce } = await challenge();

    const res = await pay(buyer.rawKey, { nonce });

    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: "insufficient_funds", balance: "0" });
    const [stored] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(stored!.reservedAt).toBeNull();
  });

  it("reports 410 before 402 for an expired Challenge and an empty wallet", async () => {
    const buyer = await createBuyer(db);
    const { nonce } = await challenge();
    await db
      .update(challenges)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(challenges.nonce, nonce));
    expect((await pay(buyer.rawKey, { nonce })).status).toBe(410);
  });

  it("does not let two payments overdraw a wallet", async () => {
    const buyer = await createBuyer(db, 2_000n);
    const first = await challenge();
    const second = await challenge();

    const results = await Promise.all([
      pay(buyer.rawKey, { nonce: first.nonce }),
      pay(buyer.rawKey, { nonce: second.nonce }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 402]);
    expect(await availableFunds(db, buyer.orgId)).toBe(0n);
  });

  it("rejects a missing or wrong Key with 401", async () => {
    const { nonce } = await challenge();
    for (const key of [undefined, "pk_agent_wrong"]) {
      const res = await pay(key, { nonce });
      expect(res.status).toBe(401);
      expect(await errorOf(res)).toMatchObject({ code: "invalid_key" });
    }
  });

  it("returns 423 agent_frozen with the scope, and reserves nothing", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge();
    const [team] = await db
      .insert(teams)
      .values({ orgId: buyer.orgId, name: `team-${randomUUID()}`, frozenAt: new Date() })
      .returning({ id: teams.id });
    await db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, buyer.agentId));

    const res = await pay(buyer.rawKey, { nonce });

    expect(res.status).toBe(423);
    expect(await errorOf(res)).toMatchObject({ code: "agent_frozen", scope: "team" });
    const [stored] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(stored!.reservedAt).toBeNull();
  });

  it("checks the Key before anything about the request", async () => {
    const res = await pay("pk_agent_wrong", "not json");
    expect(res.status).toBe(401);
  });

  it("returns 400 for a body with no nonce, and 404 for an unknown one", async () => {
    const buyer = await createBuyer(db, 10_000n);

    const noNonce = await pay(buyer.rawKey, { something: "else" });
    expect(noNonce.status).toBe(400);
    expect(await errorOf(noNonce)).toMatchObject({ code: "invalid_request" });

    const notJson = await pay(buyer.rawKey, "not json");
    expect(notJson.status).toBe(400);

    const unknown = await pay(buyer.rawKey, { nonce: "c_does_not_exist" });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toMatchObject({ code: "not_found" });
  });

  it("only lets the buyer a keyed Challenge was issued to pay it", async () => {
    const issuedTo = await createBuyer(db, 10_000n);
    const other = await createBuyer(db, 10_000n);
    const { nonce } = await challenge(issuedTo.rawKey);

    const res = await pay(other.rawKey, { nonce });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "challenge_buyer_mismatch" });
    expect(await availableFunds(db, other.orgId)).toBe(10_000n);
    expect((await pay(issuedTo.rawKey, { nonce })).status).toBe(200);
  });

  it("lets another agent from the same buyer org pay a keyed Challenge", async () => {
    const buyer = await createBuyer(db, 10_000n);
    const { nonce } = await challenge(buyer.rawKey);

    const [secondAgent] = await db
      .insert(agents)
      .values({ orgId: buyer.orgId, name: "second-agent" })
      .returning({ id: agents.id });
    const key = await createKey(db, secondAgent!.id);

    expect((await pay(key.rawKey, { nonce })).status).toBe(200);
    const [stored] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
    expect(stored!.agentId).toBe(secondAgent!.id);
  });
});
