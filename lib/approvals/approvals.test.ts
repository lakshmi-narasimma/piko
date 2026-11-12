import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import {
  createBuyer,
  createSeller,
  gatewayRequest,
  stubGatewayEnv,
  TEST_GATEWAY_CONFIG as config,
} from "../../test/gateway-fixtures";
import { createDb, type Db } from "../db/client";
import { accounts, challenges } from "../db/schema";
import { handleGatewayRequest } from "../gateway";
import { handlePayRequest } from "../pay";
import { createPolicy } from "../policy";
import type { PaymentRequired } from "../x402";
import { ApprovalError, decideApproval, getApproval, listPendingApprovals } from "./index";
import { handleApprovalPoll } from "./poll";

const url = inject("testDatabaseUrl");
const UPSTREAM = "http://127.0.0.1:1";

describe.skipIf(!url)("Approvals", () => {
  let db: Db;

  beforeAll(() => {
    stubGatewayEnv();
    db = createDb(url!, { max: 10 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end();
  });

  /** A funded buyer whose payments over $0.001 need approval, its admin, and a seller. */
  async function setup() {
    const b = await createBuyer(db, 1_000_000n);
    await createPolicy(db, {
      orgId: b.orgId,
      sourceText: "Anything over a tenth of a cent needs my OK.",
      document: { scope: { org: true }, rules: [{ type: "approval_above", maxMicroUsd: 1000 }] },
      confirmed: true,
    });
    const [account] = await db
      .insert(accounts)
      .values({ email: `admin-${randomUUID()}@piko.test`, name: "Dana" })
      .returning({ id: accounts.id });
    const admin = { account: { id: account!.id }, org: { id: b.orgId }, role: "admin" as const };
    const seller = await createSeller(db, UPSTREAM, { priceMicro: 3_000n });
    return { ...b, admin, seller };
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

  function poll(key: string, id: string) {
    return handleApprovalPoll(
      { db, config },
      new Request(`https://piko.test/api/approvals/${id}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      id,
    );
  }

  const errorOf = async (res: Response) =>
    ((await res.json()) as { error: Record<string, unknown> }).error;

  async function pending() {
    const s = await setup();
    const nonce = await challenge(s.seller, s.rawKey);
    const res = await pay(s.rawKey, nonce);
    expect(res.status).toBe(202);
    const error = await errorOf(res);
    return { ...s, nonce, approvalId: error.approvalId as string, error };
  }

  it("answers 202 approval_pending with the approval, its URLs and the nonce", async () => {
    const { nonce, approvalId, error, orgId, rawKey } = await pending();
    expect(error).toMatchObject({
      code: "approval_pending",
      approvalId,
      nonce,
      amount: "3000",
      pollUrl: `${config.appBaseUrl}/api/approvals/${approvalId}`,
      approvalUrl: `${config.appBaseUrl}/org#approvals`,
    });

    // A retry finds the same Approval instead of making another.
    expect(await errorOf(await pay(rawKey, nonce))).toMatchObject({ approvalId });
    const inbox = await listPendingApprovals(db, orgId);
    expect(inbox.map((a) => a.id)).toEqual([approvalId]);
    expect(inbox[0]).toMatchObject({ amountMicro: 3000n, path: "/history" });

    const res = await poll(rawKey, approvalId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: approvalId, status: "pending", nonce, amount: "3000" });
    expect(body.receipt).toBeUndefined();
  });

  it("approving lets the poll return a Receipt, even after the Challenge's normal expiry", async () => {
    const { nonce, approvalId, admin, orgId, rawKey } = await pending();
    // The human took longer than the Challenge's lifetime.
    await db
      .update(challenges)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 minute'` })
      .where(eq(challenges.nonce, nonce));

    await decideApproval(db, admin, approvalId, "approved");
    expect(await listPendingApprovals(db, orgId)).toEqual([]);

    const res = await poll(rawKey, approvalId);
    const body = await res.json();
    expect(body).toMatchObject({ status: "approved", amount: "3000" });
    expect(typeof body.receipt).toBe("string");
    expect(typeof body.paymentSignature).toBe("string");

    // Polling again during the hold gives the very same Receipt.
    expect((await (await poll(rawKey, approvalId)).json()).receipt).toBe(body.receipt);
  });

  it("denying makes the poll say denied and the payment a 403", async () => {
    const { nonce, approvalId, admin, rawKey } = await pending();
    await decideApproval(db, admin, approvalId, "denied");

    const body = await (await poll(rawKey, approvalId)).json();
    expect(body).toMatchObject({ status: "denied" });
    expect(body.receipt).toBeUndefined();

    const res = await pay(rawKey, nonce);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "policy_denied", rule: "approval_above" });
  });

  it("only an admin of the same org decides, and only once", async () => {
    const { approvalId, admin } = await pending();
    await expect(
      decideApproval(db, { ...admin, role: "member" }, approvalId, "approved"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decideApproval(db, { ...admin, org: { id: randomUUID() } }, approvalId, "approved"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(decideApproval(db, admin, "not-a-uuid", "approved")).rejects.toBeInstanceOf(
      ApprovalError,
    );

    await decideApproval(db, admin, approvalId, "denied");
    await expect(decideApproval(db, admin, approvalId, "approved")).rejects.toMatchObject({
      code: "already_decided",
    });
    expect((await getApproval(db, admin.org.id, approvalId))!.status).toBe("denied");
  });

  it("the poll needs the agent's Key and hides other orgs' approvals", async () => {
    const { approvalId } = await pending();
    const other = await createBuyer(db);
    expect((await poll(other.rawKey, approvalId)).status).toBe(404);
    expect((await poll("pk_agent_wrong", approvalId)).status).toBe(401);
  });

  it("an autopay 202 carries the Challenge nonce", async () => {
    const s = await setup();
    const res = await handleGatewayRequest(
      { db, config },
      gatewayRequest("GET", `https://piko.test/g/${s.seller.slug}/history`, {
        key: s.rawKey,
        headers: { "X-Piko-Autopay": "true" },
      }),
      { seller: s.seller.slug, path: ["history"] },
    );
    expect(res.status).toBe(202);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code: "approval_pending" });
    expect(typeof error.nonce).toBe("string");
    const approval = await getApproval(db, s.orgId, error.approvalId as string);
    expect(approval!.challengeNonce).toBe(error.nonce);
  });
});
