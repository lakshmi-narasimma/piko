import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { ledgerEntries, orgs, topups } from "../db/schema";
import { balanceOf } from "../ledger";
import { PayPalError, type PayPalClient } from "../paypal";
import { captureTopup, completeTopup, createTopup, TopupError } from "./index";

const url = inject("testDatabaseUrl");

/** A PayPal that approves every order for the amount it was created with. */
function fakePayPal(options: { approved?: boolean } = {}) {
  const orders = new Map<string, string>();
  let captures = 0;
  const calls: string[] = [];
  const client = {
    async request(method: string, path: string, init?: { body?: unknown }) {
      calls.push(`${method} ${path}`);
      if (method === "POST" && path === "/v2/checkout/orders") {
        const id = `ORDER-${randomUUID()}`;
        const unit = (init!.body as { purchase_units: Array<{ amount: { value: string } }> })
          .purchase_units[0]!;
        orders.set(id, unit.amount.value);
        return { id, status: "CREATED" };
      }
      const orderId = path.split("/")[4]!;
      if (path.endsWith("/capture")) {
        if (options.approved === false) {
          throw new PayPalError("not approved", 422, "UNPROCESSABLE_ENTITY", "dbg", [
            "ORDER_NOT_APPROVED: not approved",
          ]);
        }
        captures += 1;
      }
      return {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: `CAP-${orderId}`,
                  status: "COMPLETED",
                  amount: { currency_code: "USD", value: orders.get(orderId) },
                },
              ],
            },
          },
        ],
      };
    },
  };
  return { paypal: client as unknown as PayPalClient, calls, captureCount: () => captures };
}

describe.skipIf(!url)("top-ups", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url!);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  async function newOrg() {
    const [org] = await db
      .insert(orgs)
      .values({
        name: "Topup Test",
        slug: `topup-${randomUUID()}`,
        kind: "personal",
        billing: "prepaid",
      })
      .returning({ id: orgs.id });
    return org!.id;
  }
  const wallet = (orgId: string) => balanceOf(db, { type: "wallet", orgId });

  it("creates an order and a created top-up row", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 5_000_000n });
    const [row] = await db.select().from(topups).where(eq(topups.paypalOrderId, orderId));
    expect(row).toMatchObject({ orgId, amountMicro: 5_000_000n, status: "created" });
    expect(await wallet(orgId)).toBe(0n);
  });

  it("rejects amounts out of range or not in whole cents", async () => {
    const orgId = await newOrg();
    const { paypal, calls } = fakePayPal();
    for (const amountMicro of [500_000n, 600_000_000n, 1_000_001n]) {
      await expect(createTopup(db, paypal, { orgId, amountMicro })).rejects.toMatchObject({
        code: "invalid_amount",
      });
    }
    expect(calls).toEqual([]);
  });

  it("credits the Wallet on capture, and only once however often it is repeated", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 5_000_000n });

    const first = await captureTopup(db, paypal, { orgId, orderId });
    expect(first).toMatchObject({ credited: true, balanceMicro: 5_000_000n });
    const second = await captureTopup(db, paypal, { orgId, orderId });
    expect(second).toMatchObject({ credited: false, balanceMicro: 5_000_000n });
    expect(await wallet(orgId)).toBe(5_000_000n);
  });

  it("credits once when the capture is double-clicked concurrently", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 5_000_000n });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => captureTopup(db, paypal, { orgId, orderId })),
    );
    expect(results.filter((r) => r.credited)).toHaveLength(1);
    expect(await wallet(orgId)).toBe(5_000_000n);
  });

  it("credits once when the webhook and the capture route both complete it", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 2_500_000n });

    const hook = await completeTopup(db, {
      orderId,
      captureId: `CAP-${orderId}`,
      paidMicro: 2_500_000n,
    });
    expect(hook.credited).toBe(true);
    const capture = await captureTopup(db, paypal, { orgId, orderId });
    expect(capture.credited).toBe(false);
    expect(await wallet(orgId)).toBe(2_500_000n);
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.orgId, orgId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: "topup", refId: `CAP-${orderId}` });
  });

  it("credits nothing when the buyer never approved", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal({ approved: false });
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 5_000_000n });
    await expect(captureTopup(db, paypal, { orgId, orderId })).rejects.toMatchObject({
      code: "not_approved",
    });
    expect(await wallet(orgId)).toBe(0n);
    const [row] = await db.select().from(topups).where(eq(topups.paypalOrderId, orderId));
    expect(row!.status).toBe("created");
  });

  it("won't let another org capture the order", async () => {
    const owner = await newOrg();
    const other = await newOrg();
    const { paypal, captureCount } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId: owner, amountMicro: 5_000_000n });
    await expect(captureTopup(db, paypal, { orgId: other, orderId })).rejects.toBeInstanceOf(
      TopupError,
    );
    expect(captureCount()).toBe(0);
    expect(await wallet(other)).toBe(0n);
  });

  it("refuses to credit an amount that differs from the top-up", async () => {
    const orgId = await newOrg();
    const { paypal } = fakePayPal();
    const { orderId } = await createTopup(db, paypal, { orgId, amountMicro: 5_000_000n });
    await expect(
      completeTopup(db, { orderId, captureId: "CAP-x", paidMicro: 1_000_000n }),
    ).rejects.toMatchObject({ code: "amount_mismatch" });
    expect(await wallet(orgId)).toBe(0n);
  });
});
