import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { agents, challenges, endpoints, ledgerEntries, listings, orgs } from "../db/schema";
import {
  availableFunds,
  balanceOf,
  InsufficientFundsError,
  LedgerError,
  postCall,
  refundCall,
  reserveFunds,
  settleCall,
  type LedgerErrorCode,
} from "./index";

const url = inject("testDatabaseUrl");

// postCall reads PLATFORM_FEE_BPS through getEnv, which validates the whole environment.
const ENV = {
  APP_BASE_URL: "http://localhost:3000",
  SESSION_SECRET: "test",
  RECEIPT_SIGNING_SECRET: "test",
  DATABASE_URL: "postgresql://unused@localhost/unused",
  DATABASE_URL_POOLED: "postgresql://unused@localhost/unused",
  PAYPAL_CLIENT_ID: "test",
  PAYPAL_CLIENT_SECRET: "test",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "test",
  PAYPAL_DEMO_SHOP_EMAIL: "shop@example.com",
  GEMINI_API_KEY: "test",
  PLATFORM_FEE_BPS: "500",
};

/** A small seeded generator, so the random run is the same every time. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!url)("ledger", () => {
  let db: Db;

  const wallet = (orgId: string) => balanceOf(db, { type: "wallet", orgId });
  const seller = (orgId: string) => balanceOf(db, { type: "seller", orgId });

  async function createOrg(overrides: Partial<typeof orgs.$inferInsert> = {}) {
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Ledger Test",
        slug: `ledger-test-${randomUUID()}`,
        kind: "personal",
        billing: "prepaid",
        ...overrides,
      })
      .returning({ id: orgs.id });
    return org!.id;
  }

  async function fund(orgId: string, amountMicro: bigint) {
    await db.insert(ledgerEntries).values({
      txnId: randomUUID(),
      accountType: "wallet",
      orgId,
      amountMicro,
      reason: "seed",
      refId: randomUUID(),
    });
  }

  /** A seller's endpoint, plus a buyer agent to pay it. */
  async function createMarket(buyerOrgId: string, sellerOrgId: string) {
    const [listing] = await db
      .insert(listings)
      .values({
        sellerOrgId,
        slug: `listing-${randomUUID()}`,
        name: "Test Listing",
        description: "For ledger tests",
        baseUrl: "https://example.com",
        kind: "http",
      })
      .returning({ id: listings.id });
    const [endpoint] = await db
      .insert(endpoints)
      .values({
        listingId: listing!.id,
        method: "GET",
        pathOrTool: `/x-${randomUUID()}`,
        priceMicro: 2000n,
      })
      .returning({ id: endpoints.id });
    const [agent] = await db
      .insert(agents)
      .values({ orgId: buyerOrgId, name: `agent-${randomUUID()}` })
      .returning({ id: agents.id });
    return { endpointId: endpoint!.id, agentId: agent!.id };
  }

  async function createChallenge(endpointId: string, amountMicro: bigint) {
    const nonce = `c_${randomUUID()}`;
    await db.insert(challenges).values({
      nonce,
      endpointId,
      amountMicro,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return nonce;
  }

  /** A buyer with a funded wallet, a seller and an endpoint between them. */
  async function createScenario(balanceMicro: bigint) {
    const buyerOrgId = await createOrg();
    const sellerOrgId = await createOrg();
    await fund(buyerOrgId, balanceMicro);
    return { buyerOrgId, sellerOrgId, ...(await createMarket(buyerOrgId, sellerOrgId)) };
  }

  const entriesFor = (refId: string) =>
    db.select().from(ledgerEntries).where(eq(ledgerEntries.refId, refId));

  const failure = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error("Expected a LedgerError, but the call succeeded.");
      },
      (error: unknown) => {
        if (error instanceof LedgerError) return error;
        throw error;
      },
    );

  const codeOf = async (work: Promise<unknown>): Promise<LedgerErrorCode> =>
    (await failure(work)).code;

  const expireReservation = (nonce: string) =>
    db
      .update(challenges)
      .set({ reservationExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(challenges.nonce, nonce));

  beforeAll(() => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    db = createDb(url!, { max: 25 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  describe("postCall", () => {
    it("writes exactly buyer -2000, seller +1900, platform +100 for a $0.002 Call", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const callId = randomUUID();

      const posted = await postCall(db, { callId, buyerOrgId, sellerOrgId, priceMicro: 2000n });

      const rows = await entriesFor(callId);
      expect(rows).toHaveLength(3);
      const amount = (type: string) => rows.find((r) => r.accountType === type)?.amountMicro;
      expect(amount("wallet")).toBe(-2000n);
      expect(amount("seller")).toBe(1900n);
      expect(amount("platform")).toBe(100n);
      expect(rows.reduce((sum, r) => sum + r.amountMicro, 0n)).toBe(0n);
      expect(new Set(rows.map((r) => r.txnId))).toEqual(new Set([posted.txnId]));
      expect(rows.every((r) => r.reason === "call")).toBe(true);
      expect(posted).toMatchObject({ sellerMicro: 1900n, platformMicro: 100n });
    });

    it("rounds the seller down at 3 micro-USD and the platform takes the remainder", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const callId = randomUUID();

      await postCall(db, { callId, buyerOrgId, sellerOrgId, priceMicro: 3n });

      const rows = await entriesFor(callId);
      const amount = (type: string) => rows.find((r) => r.accountType === type)?.amountMicro;
      expect(amount("wallet")).toBe(-3n);
      expect(amount("seller")).toBe(2n);
      expect(amount("platform")).toBe(1n);
      expect(rows.reduce((sum, r) => sum + r.amountMicro, 0n)).toBe(0n);
    });

    it("rejects a second post of the same Call without writing anything", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const input = { callId: randomUUID(), buyerOrgId, sellerOrgId, priceMicro: 2000n };

      await postCall(db, input);

      expect(await codeOf(postCall(db, input))).toBe("call_already_posted");
      expect(await entriesFor(input.callId)).toHaveLength(3);
    });

    it("rejects a non-positive price", async () => {
      const buyerOrgId = await createOrg();
      const input = { callId: randomUUID(), buyerOrgId, sellerOrgId: buyerOrgId, priceMicro: 0n };
      expect(await codeOf(postCall(db, input))).toBe("invalid_amount");
    });

    it("rolls back with the caller's transaction", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const callId = randomUUID();

      await db
        .transaction(async (tx) => {
          await postCall(tx, { callId, buyerOrgId, sellerOrgId, priceMicro: 2000n });
          throw new Error("rollback");
        })
        .catch(() => undefined);

      expect(await entriesFor(callId)).toHaveLength(0);
    });

    it("leaves the caller's transaction usable after a duplicate", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const input = { callId: randomUUID(), buyerOrgId, sellerOrgId, priceMicro: 2000n };
      await postCall(db, input);

      const after = await db.transaction(async (tx) => {
        expect(await codeOf(postCall(tx, input))).toBe("call_already_posted");
        return balanceOf(tx, { type: "wallet", orgId: buyerOrgId });
      });

      expect(after).toBe(-2000n);
    });
  });

  describe("refundCall", () => {
    it("writes three reversing entries and restores every balance", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      await fund(buyerOrgId, 10_000n);
      const callId = randomUUID();
      await postCall(db, { callId, buyerOrgId, sellerOrgId, priceMicro: 2000n });

      const refund = await refundCall(db, callId);

      const rows = await entriesFor(callId);
      const reversing = rows.filter((r) => r.reason === "refund");
      const amount = (type: string) => reversing.find((r) => r.accountType === type)?.amountMicro;
      expect(reversing).toHaveLength(3);
      expect(amount("wallet")).toBe(2000n);
      expect(amount("seller")).toBe(-1900n);
      expect(amount("platform")).toBe(-100n);
      expect(new Set(reversing.map((r) => r.txnId))).toEqual(new Set([refund.txnId]));
      expect(refund.refundedMicro).toBe(2000n);
      expect(await wallet(buyerOrgId)).toBe(10_000n);
      expect(await seller(sellerOrgId)).toBe(0n);
      // The platform account is global, so measure only this Call's entries on it.
      expect(rows.filter((r) => r.accountType === "platform").map((r) => r.amountMicro)).toEqual(
        expect.arrayContaining([100n, -100n]),
      );
    });

    it("rejects refunding twice without writing more entries", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const callId = randomUUID();
      await postCall(db, { callId, buyerOrgId, sellerOrgId, priceMicro: 2000n });
      await refundCall(db, callId);

      expect(await codeOf(refundCall(db, callId))).toBe("call_already_refunded");
      expect(await entriesFor(callId)).toHaveLength(6);
    });

    it("lets exactly one of two concurrent refunds through", async () => {
      const buyerOrgId = await createOrg();
      const sellerOrgId = await createOrg();
      const callId = randomUUID();
      await postCall(db, { callId, buyerOrgId, sellerOrgId, priceMicro: 2000n });

      const results = await Promise.allSettled([refundCall(db, callId), refundCall(db, callId)]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect((rejected?.reason as LedgerError).code).toBe("call_already_refunded");
      expect(await wallet(buyerOrgId)).toBe(0n);
    });

    it("rejects refunding a Call that was never posted", async () => {
      const callId = randomUUID();
      expect(await codeOf(refundCall(db, callId))).toBe("call_not_posted");
      expect(await entriesFor(callId)).toHaveLength(0);
    });
  });

  describe("balanceOf", () => {
    it("is zero for an account with no entries", async () => {
      expect(await wallet(await createOrg())).toBe(0n);
    });

    it("keeps an org's wallet and seller balances apart", async () => {
      const orgId = await createOrg();
      const other = await createOrg();
      await postCall(db, {
        callId: randomUUID(),
        buyerOrgId: orgId,
        sellerOrgId: other,
        priceMicro: 2000n,
      });
      await postCall(db, {
        callId: randomUUID(),
        buyerOrgId: other,
        sellerOrgId: orgId,
        priceMicro: 1000n,
      });

      expect(await wallet(orgId)).toBe(-2000n);
      expect(await seller(orgId)).toBe(950n);
    });

    it("sums every platform entry", async () => {
      // Other test files write platform entries too, so read both sides in one snapshot.
      const [balance, total] = await db.transaction(
        async (tx) => {
          const balance = await balanceOf(tx, { type: "platform" });
          const [row] = await tx
            .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
            .from(ledgerEntries)
            .where(and(eq(ledgerEntries.accountType, "platform"), isNull(ledgerEntries.orgId)));
          return [balance, BigInt(row!.total)];
        },
        { isolationLevel: "repeatable read" },
      );
      expect(balance).toBe(total);
    });

    it(
      "equals the sum of entries after 1,000 random Calls and refunds",
      { timeout: 120_000 },
      async () => {
        const random = mulberry32(20261112);
        const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
        const buyers = await Promise.all([createOrg(), createOrg(), createOrg()]);
        const sellers = await Promise.all([createOrg(), createOrg(), createOrg()]);

        const expected = new Map<string, bigint>(
          [...buyers, ...sellers].map((orgId) => [orgId, 0n]),
        );
        const adjust = (orgId: string, delta: bigint) =>
          expected.set(orgId, expected.get(orgId)! + delta);

        const open: { callId: string; buyerOrgId: string; sellerOrgId: string; price: bigint }[] =
          [];
        const callIds: string[] = [];
        let platformExpected = 0n;

        for (let i = 0; i < 1000; i++) {
          if (open.length > 0 && random() < 0.3) {
            const [call] = open.splice(Math.floor(random() * open.length), 1);
            const seller = (call!.price * 9500n) / 10_000n;
            await refundCall(db, call!.callId);
            adjust(call!.buyerOrgId, call!.price);
            adjust(call!.sellerOrgId, -seller);
            platformExpected -= call!.price - seller;
          } else {
            const call = {
              callId: randomUUID(),
              buyerOrgId: pick(buyers),
              sellerOrgId: pick(sellers),
              price: BigInt(1 + Math.floor(random() * 100_000)),
            };
            const { sellerMicro, platformMicro } = await postCall(db, {
              callId: call.callId,
              buyerOrgId: call.buyerOrgId,
              sellerOrgId: call.sellerOrgId,
              priceMicro: call.price,
            });
            adjust(call.buyerOrgId, -call.price);
            adjust(call.sellerOrgId, sellerMicro);
            platformExpected += platformMicro;
            open.push(call);
            callIds.push(call.callId);
          }
        }

        const sumEntries = async (accountType: "wallet" | "seller", orgId: string) => {
          const [row] = await db
            .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
            .from(ledgerEntries)
            .where(and(eq(ledgerEntries.accountType, accountType), eq(ledgerEntries.orgId, orgId)));
          return BigInt(row!.total);
        };

        for (const orgId of buyers) {
          expect(await wallet(orgId)).toBe(expected.get(orgId));
          expect(await wallet(orgId)).toBe(await sumEntries("wallet", orgId));
        }
        for (const orgId of sellers) {
          expect(await seller(orgId)).toBe(expected.get(orgId));
          expect(await seller(orgId)).toBe(await sumEntries("seller", orgId));
        }

        const [platform] = await db
          .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
          .from(ledgerEntries)
          .where(
            and(eq(ledgerEntries.accountType, "platform"), inArray(ledgerEntries.refId, callIds)),
          );
        expect(BigInt(platform!.total)).toBe(platformExpected);

        const [all] = await db
          .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMicro}), 0)` })
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.refId, callIds));
        expect(BigInt(all!.total)).toBe(0n);
      },
    );
  });

  describe("reserveFunds", () => {
    it("holds the amount on the Challenge and writes no Ledger entry", async () => {
      const s = await createScenario(5000n);
      const nonce = await createChallenge(s.endpointId, 2000n);

      const reservation = await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });

      expect(reservation.amountMicro).toBe(2000n);
      expect(reservation.reservationExpiresAt.getTime()).toBeGreaterThan(Date.now());
      const [row] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
      expect(row).toMatchObject({ agentId: s.agentId, buyerOrgId: s.buyerOrgId, consumedAt: null });
      expect(row?.reservedAt).toBeInstanceOf(Date);
      expect(await availableFunds(db, s.buyerOrgId)).toBe(3000n);
      expect(await wallet(s.buyerOrgId)).toBe(5000n);
    });

    it("throws a typed insufficient_funds error carrying the amounts", async () => {
      const s = await createScenario(1000n);
      const nonce = await createChallenge(s.endpointId, 2000n);

      const error = await failure(
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 }),
      );

      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect(error.code).toBe("insufficient_funds");
      expect(error).toMatchObject({ requiredMicro: 2000n, availableMicro: 1000n });
      const [row] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
      expect(row?.reservedAt).toBeNull();
    });

    it("counts earlier active reservations against the balance", async () => {
      const s = await createScenario(3000n);
      const reserve = (nonce: string) =>
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 });

      await reserve(await createChallenge(s.endpointId, 2000n));

      expect(await codeOf(reserve(await createChallenge(s.endpointId, 2000n)))).toBe(
        "insufficient_funds",
      );
    });

    it("frees the funds once a reservation expires", async () => {
      const s = await createScenario(2000n);
      const reserve = (nonce: string) =>
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 });
      const first = await createChallenge(s.endpointId, 2000n);
      await reserve(first);

      await expireReservation(first);

      expect(await availableFunds(db, s.buyerOrgId)).toBe(2000n);
      await expect(reserve(await createChallenge(s.endpointId, 2000n))).resolves.toBeDefined();
    });

    it("uses the credit limit for an invoiced org and ignores it for a prepaid one", async () => {
      const invoiced = await createOrg({ billing: "invoiced", creditLimitMicro: 5000n });
      const prepaid = await createOrg({ billing: "prepaid", creditLimitMicro: 5000n });
      const sellerOrgId = await createOrg();
      const market = await createMarket(invoiced, sellerOrgId);
      const prepaidMarket = await createMarket(prepaid, sellerOrgId);

      await reserveFunds(db, {
        nonce: await createChallenge(market.endpointId, 5000n),
        agentId: market.agentId,
        buyerOrgId: invoiced,
        ttlSeconds: 60,
      });

      expect(await availableFunds(db, invoiced)).toBe(0n);
      expect(await availableFunds(db, prepaid)).toBe(0n);
      expect(
        await codeOf(
          reserveFunds(db, {
            nonce: await createChallenge(prepaidMarket.endpointId, 1n),
            agentId: prepaidMarket.agentId,
            buyerOrgId: prepaid,
            ttlSeconds: 60,
          }),
        ),
      ).toBe("insufficient_funds");
    });

    it("rejects an unknown, expired, consumed or already reserved Challenge", async () => {
      const s = await createScenario(10_000n);
      const reserve = (nonce: string) =>
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 });

      expect(await codeOf(reserve("c_missing"))).toBe("challenge_not_found");

      const expired = await createChallenge(s.endpointId, 2000n);
      await db
        .update(challenges)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(challenges.nonce, expired));
      expect(await codeOf(reserve(expired))).toBe("challenge_expired");

      const reserved = await createChallenge(s.endpointId, 2000n);
      await reserve(reserved);
      const [otherAgent] = await db
        .insert(agents)
        .values({ orgId: s.buyerOrgId, name: `agent-${randomUUID()}` })
        .returning({ id: agents.id });
      expect(
        await codeOf(
          reserveFunds(db, {
            nonce: reserved,
            agentId: otherAgent!.id,
            buyerOrgId: s.buyerOrgId,
            ttlSeconds: 60,
          }),
        ),
      ).toBe("challenge_already_reserved");

      await settleCall(db, { nonce: reserved, callId: randomUUID() });
      expect(await codeOf(reserve(reserved))).toBe("challenge_consumed");
    });

    it("returns the same hold when the same agent reserves again before it is used", async () => {
      const s = await createScenario(10_000n);
      const nonce = await createChallenge(s.endpointId, 2000n);
      const reserve = () =>
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 });

      const first = await reserve();
      // The hold outlives the Challenge's own expiry, and a retry must still work.
      await db
        .update(challenges)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(challenges.nonce, nonce));
      const again = await reserve();

      expect(first.reissued).toBe(false);
      expect(again).toEqual({ ...first, reissued: true });
      expect(await availableFunds(db, s.buyerOrgId)).toBe(8000n);
    });

    it("does not hand back a hold whose expiry has moved, or one that ended", async () => {
      const s = await createScenario(10_000n);
      const reserve = (nonce: string) =>
        reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: s.buyerOrgId, ttlSeconds: 60 });

      const claimed = await createChallenge(s.endpointId, 2000n);
      await reserve(claimed);
      // What claiming the hold for a Call does: its expiry moves past the Receipt's.
      await db
        .update(challenges)
        .set({ reservationExpiresAt: sql`reservation_expires_at + interval '2 seconds'` })
        .where(eq(challenges.nonce, claimed));
      expect(await codeOf(reserve(claimed))).toBe("challenge_already_reserved");

      const ended = await createChallenge(s.endpointId, 2000n);
      const first = await reserve(ended);
      await expireReservation(ended);
      const fresh = await reserve(ended);
      expect(fresh.reissued).toBe(false);
      expect(fresh.reservationExpiresAt.getTime()).toBeGreaterThan(
        first.reservationExpiresAt.getTime(),
      );
    });

    it("only lets the buyer org a Challenge is bound to reserve it", async () => {
      const s = await createScenario(10_000n);
      const other = await createScenario(10_000n);
      const reserve = (buyer: { agentId: string; buyerOrgId: string }, nonce: string) =>
        reserveFunds(db, { nonce, ...buyer, ttlSeconds: 60 });

      const keyed = await createChallenge(s.endpointId, 2000n);
      await db
        .update(challenges)
        .set({ buyerOrgId: s.buyerOrgId, agentId: s.agentId })
        .where(eq(challenges.nonce, keyed));
      expect(await codeOf(reserve(other, keyed))).toBe("challenge_buyer_mismatch");
      await expect(reserve(s, keyed)).resolves.toMatchObject({ reissued: false });

      // A hold binds an anonymous Challenge to its payer, even after the hold ends.
      const anonymous = await createChallenge(s.endpointId, 2000n);
      await reserve(s, anonymous);
      await expireReservation(anonymous);
      expect(await codeOf(reserve(other, anonymous))).toBe("challenge_buyer_mismatch");
      expect(await availableFunds(db, other.buyerOrgId)).toBe(10_000n);
    });

    it("rejects an unknown org", async () => {
      const s = await createScenario(10_000n);
      const nonce = await createChallenge(s.endpointId, 2000n);
      expect(
        await codeOf(
          reserveFunds(db, { nonce, agentId: s.agentId, buyerOrgId: randomUUID(), ttlSeconds: 60 }),
        ),
      ).toBe("org_not_found");
    });
  });

  describe("settleCall", () => {
    it("consumes the reservation and posts the Call to the endpoint's seller", async () => {
      const s = await createScenario(5000n);
      const nonce = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });
      const callId = randomUUID();

      const settled = await settleCall(db, { nonce, callId });

      expect(settled).toMatchObject({
        callId,
        nonce,
        agentId: s.agentId,
        endpointId: s.endpointId,
        buyerOrgId: s.buyerOrgId,
        sellerOrgId: s.sellerOrgId,
        priceMicro: 2000n,
      });
      expect(await wallet(s.buyerOrgId)).toBe(3000n);
      expect(await seller(s.sellerOrgId)).toBe(1900n);
      // The hold is gone, and the debit is not counted twice.
      expect(await availableFunds(db, s.buyerOrgId)).toBe(3000n);
      const [row] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
      expect(row?.consumedAt).toBeInstanceOf(Date);
    });

    it("rejects settling a consumed Challenge", async () => {
      const s = await createScenario(5000n);
      const nonce = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });
      await settleCall(db, { nonce, callId: randomUUID() });

      const second = randomUUID();
      expect(await codeOf(settleCall(db, { nonce, callId: second }))).toBe("challenge_consumed");
      expect(await entriesFor(second)).toHaveLength(0);
      expect(await wallet(s.buyerOrgId)).toBe(3000n);
    });

    it("settles exactly once when two settles race", async () => {
      const s = await createScenario(5000n);
      const nonce = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });

      const results = await Promise.allSettled([
        settleCall(db, { nonce, callId: randomUUID() }),
        settleCall(db, { nonce, callId: randomUUID() }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect((rejected?.reason as LedgerError).code).toBe("challenge_consumed");
      expect(await wallet(s.buyerOrgId)).toBe(3000n);
    });

    it("rejects a Challenge with no reservation, an expired one or an unknown nonce", async () => {
      const s = await createScenario(5000n);
      const settle = (nonce: string) => settleCall(db, { nonce, callId: randomUUID() });

      expect(await codeOf(settle("c_missing"))).toBe("challenge_not_found");

      const unreserved = await createChallenge(s.endpointId, 2000n);
      expect(await codeOf(settle(unreserved))).toBe("reservation_not_active");

      const lapsed = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce: lapsed,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });
      await expireReservation(lapsed);
      expect(await codeOf(settle(lapsed))).toBe("reservation_not_active");

      expect(await wallet(s.buyerOrgId)).toBe(5000n);
    });

    it("leaves the reservation unconsumed if the Call can't be posted", async () => {
      const s = await createScenario(5000n);
      const callId = randomUUID();
      await postCall(db, {
        callId,
        buyerOrgId: s.buyerOrgId,
        sellerOrgId: s.sellerOrgId,
        priceMicro: 1n,
      });
      const nonce = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });

      expect(await codeOf(settleCall(db, { nonce, callId }))).toBe("call_already_posted");

      const [row] = await db.select().from(challenges).where(eq(challenges.nonce, nonce));
      expect(row?.consumedAt).toBeNull();
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two Calls through on a $0.003 balance", async () => {
      const s = await createScenario(3000n);
      const pay = async () => {
        const nonce = await createChallenge(s.endpointId, 2000n);
        await reserveFunds(db, {
          nonce,
          agentId: s.agentId,
          buyerOrgId: s.buyerOrgId,
          ttlSeconds: 60,
        });
        return settleCall(db, { nonce, callId: randomUUID() });
      };

      const results = await Promise.allSettled([pay(), pay()]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(InsufficientFundsError);
      expect(await wallet(s.buyerOrgId)).toBe(1000n);
      expect(await seller(s.sellerOrgId)).toBe(1900n);
    });

    it("never over-reserves under heavy contention", async () => {
      const s = await createScenario(10_000n);
      const nonces = await Promise.all(
        Array.from({ length: 20 }, () => createChallenge(s.endpointId, 2000n)),
      );

      const results = await Promise.allSettled(
        nonces.map((nonce) =>
          reserveFunds(db, {
            nonce,
            agentId: s.agentId,
            buyerOrgId: s.buyerOrgId,
            ttlSeconds: 60,
          }),
        ),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect(await availableFunds(db, s.buyerOrgId)).toBe(0n);
    });

    /**
     * Two payments, each in the caller's own transaction at `isolationLevel`. Both take
     * their snapshot before either reserves, which is how a stale snapshot overdraws.
     */
    async function payInCallerTransactions(
      isolationLevel: "read committed" | "repeatable read" | "serializable",
    ) {
      const s = await createScenario(3000n);
      const nonces = await Promise.all([
        createChallenge(s.endpointId, 2000n),
        createChallenge(s.endpointId, 2000n),
      ]);

      let arrived = 0;
      let release!: () => void;
      const bothHaveSnapshots = new Promise<void>((resolve) => (release = resolve));

      const results = await Promise.allSettled(
        nonces.map((nonce) =>
          db.transaction(
            async (tx) => {
              await tx.execute(sql`select count(*) from ${ledgerEntries}`);
              if (++arrived === 2) release();
              await bothHaveSnapshots;
              await reserveFunds(tx, {
                nonce,
                agentId: s.agentId,
                buyerOrgId: s.buyerOrgId,
                ttlSeconds: 60,
              });
              return settleCall(tx, { nonce, callId: randomUUID() });
            },
            { isolationLevel },
          ),
        ),
      );
      return { s, results };
    }

    it("never overdraws when callers pay inside REPEATABLE READ transactions", async () => {
      const { s, results } = await payInCallerTransactions("repeatable read");

      expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toBeInstanceOf(LedgerError);
          expect((r.reason as LedgerError).code).toBe("unsupported_isolation");
        }
      }
      expect(await wallet(s.buyerOrgId)).toBeGreaterThanOrEqual(0n);
      expect(await availableFunds(db, s.buyerOrgId)).toBeGreaterThanOrEqual(0n);
    });

    it("rejects paying inside SERIALIZABLE and settling inside REPEATABLE READ", async () => {
      const { s, results } = await payInCallerTransactions("serializable");

      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      for (const r of results) {
        expect((r as PromiseRejectedResult).reason.code).toBe("unsupported_isolation");
      }
      expect(await wallet(s.buyerOrgId)).toBe(3000n);

      const nonce = await createChallenge(s.endpointId, 2000n);
      await reserveFunds(db, {
        nonce,
        agentId: s.agentId,
        buyerOrgId: s.buyerOrgId,
        ttlSeconds: 60,
      });
      expect(
        await codeOf(
          db.transaction((tx) => settleCall(tx, { nonce, callId: randomUUID() }), {
            isolationLevel: "repeatable read",
          }),
        ),
      ).toBe("unsupported_isolation");
    });

    it("lets exactly one through when callers pay inside READ COMMITTED transactions", async () => {
      const { s, results } = await payInCallerTransactions("read committed");

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(InsufficientFundsError);
      expect(await wallet(s.buyerOrgId)).toBe(1000n);
      expect(await seller(s.sellerOrgId)).toBe(1900n);
    });

    it("does not deadlock when two orgs buy from each other", { timeout: 30_000 }, async () => {
      const a = await createOrg();
      const b = await createOrg();
      await fund(a, 1_000_000n);
      await fund(b, 1_000_000n);
      const aBuys = await createMarket(a, b);
      const bBuys = await createMarket(b, a);

      const pay = async (buyerOrgId: string, market: { endpointId: string; agentId: string }) => {
        const nonce = await createChallenge(market.endpointId, 2000n);
        await reserveFunds(db, {
          nonce,
          agentId: market.agentId,
          buyerOrgId,
          ttlSeconds: 60,
        });
        return settleCall(db, { nonce, callId: randomUUID() });
      };

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => [pay(a, aBuys), pay(b, bBuys)]).flat(),
      );

      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await wallet(a)).toBe(1_000_000n - 20_000n);
      expect(await seller(a)).toBe(19_000n);
    });
  });
});
