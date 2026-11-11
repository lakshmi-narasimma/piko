import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { orgs, topups, webhookEvents } from "../db/schema";
import { balanceOf } from "../ledger";
import { toPayPalValue } from "../paypal";
import { WEBHOOK_HANDLERS } from "./handlers";
import { processWebhookEvent, type PayPalEvent } from "./index";

const url = inject("testDatabaseUrl");

function captureEvent(orderId: string, amountMicro: bigint, eventId = `WH-${randomUUID()}`) {
  return {
    id: eventId,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: `CAP-${orderId}`,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: toPayPalValue(amountMicro) },
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  } satisfies PayPalEvent;
}

describe.skipIf(!url)("webhooks", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url!);
  });
  afterAll(async () => {
    await db.$client.end();
  });

  async function newTopup(amountMicro = 5_000_000n) {
    const [org] = await db
      .insert(orgs)
      .values({ name: "Hook", slug: `hook-${randomUUID()}`, kind: "personal", billing: "prepaid" })
      .returning({ id: orgs.id });
    const orderId = `ORDER-${randomUUID()}`;
    await db.insert(topups).values({ orgId: org!.id, paypalOrderId: orderId, amountMicro });
    return { orgId: org!.id, orderId, amountMicro };
  }
  const wallet = (orgId: string) => balanceOf(db, { type: "wallet", orgId });

  it("credits a completed capture, and a replay of the same event credits nothing more", async () => {
    const { orgId, orderId, amountMicro } = await newTopup();
    const event = captureEvent(orderId, amountMicro);

    expect(await processWebhookEvent(db, event, WEBHOOK_HANDLERS)).toBe("processed");
    expect(await processWebhookEvent(db, event, WEBHOOK_HANDLERS)).toBe("duplicate");
    expect(await wallet(orgId)).toBe(amountMicro);
  });

  it("treats a second event id for the same capture as a duplicate", async () => {
    const { orgId, orderId, amountMicro } = await newTopup();
    expect(
      await processWebhookEvent(db, captureEvent(orderId, amountMicro), WEBHOOK_HANDLERS),
    ).toBe("processed");
    expect(
      await processWebhookEvent(db, captureEvent(orderId, amountMicro), WEBHOOK_HANDLERS),
    ).toBe("duplicate");
    expect(await wallet(orgId)).toBe(amountMicro);
  });

  it("stores each event once", async () => {
    const { orderId, amountMicro } = await newTopup();
    const event = captureEvent(orderId, amountMicro);
    await Promise.all([
      processWebhookEvent(db, event, WEBHOOK_HANDLERS),
      processWebhookEvent(db, event, WEBHOOK_HANDLERS),
    ]);
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.paypalEventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).not.toBeNull();
  });

  it("ignores a capture that isn't a top-up", async () => {
    const event = captureEvent(`ORDER-${randomUUID()}`, 1_000_000n);
    expect(await processWebhookEvent(db, event, WEBHOOK_HANDLERS)).toBe("processed");
  });

  it("stores unknown event types and ignores them", async () => {
    const event: PayPalEvent = {
      id: `WH-${randomUUID()}`,
      event_type: "X.Y",
      resource: { id: "r" },
    };
    expect(await processWebhookEvent(db, event, WEBHOOK_HANDLERS)).toBe("ignored");
  });

  it("retries an event whose handler failed, without crediting twice", async () => {
    const { orgId, orderId, amountMicro } = await newTopup();
    const event = captureEvent(orderId, amountMicro);
    const flaky = vi.fn().mockRejectedValueOnce(new Error("boom"));

    await expect(processWebhookEvent(db, event, { [event.event_type]: flaky })).rejects.toThrow(
      "boom",
    );
    const [stuck] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.paypalEventId, event.id));
    expect(stuck!.processedAt).toBeNull();

    expect(await processWebhookEvent(db, event, WEBHOOK_HANDLERS)).toBe("processed");
    expect(await wallet(orgId)).toBe(amountMicro);
  });
});
