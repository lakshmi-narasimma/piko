/**
 * PayPal webhook events, stored once and dispatched by type. Later phases register more
 * handlers (payouts, invoices). Every handler must be idempotent on the PayPal resource id,
 * because PayPal redelivers and a crash between handling and marking an event processed
 * means it is handled again.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { webhookEvents } from "../db/schema";

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource: Record<string, unknown> & { id?: string };
}

export type WebhookHandler = (db: Db, event: PayPalEvent) => Promise<void>;

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

/** The resource id the event is about: a capture, payout item or invoice id. */
function resourceId(event: PayPalEvent): string {
  return typeof event.resource?.id === "string" ? event.resource.id : event.id;
}

export function isPayPalEvent(value: unknown): value is PayPalEvent {
  const v = value as Partial<PayPalEvent> | null;
  return (
    typeof v?.id === "string" &&
    typeof v.event_type === "string" &&
    typeof v.resource === "object" &&
    v.resource !== null
  );
}

/**
 * Stores the event once, runs its handler, then marks it processed. A redelivery of an
 * event that already finished does nothing. One whose handler failed last time is handled
 * again. Throws when the handler throws, so the route answers 5xx and PayPal retries.
 */
export async function processWebhookEvent(
  db: Db,
  event: PayPalEvent,
  handlers: Record<string, WebhookHandler>,
): Promise<WebhookOutcome> {
  const resource = resourceId(event);
  await db
    .insert(webhookEvents)
    .values({
      paypalEventId: event.id,
      eventType: event.event_type,
      resourceId: resource,
      payload: event,
    })
    // Another event for the same resource and type (PayPal can send the same fact under
    // two event ids) is also a no-op here: the unique index is on (type, resource).
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(
      and(eq(webhookEvents.eventType, event.event_type), eq(webhookEvents.resourceId, resource)),
    );
  if (row?.processedAt) return "duplicate";

  const handler = handlers[event.event_type];
  if (handler) await handler(db, event);
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(
      and(eq(webhookEvents.eventType, event.event_type), eq(webhookEvents.resourceId, resource)),
    );
  return handler ? "processed" : "ignored";
}
