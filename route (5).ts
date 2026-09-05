import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEvents, stores, shopOrders } from "@/lib/db/schema";
import { verifyWebhookHmac, type ShopifyOrder } from "@/lib/shopify";
import { upsertOrder, computeOrderEconomics } from "@/lib/metrics";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Shopify webhook receiver.
 *
 *  - HMAC-SHA256 verified against the raw body with a constant-time compare.
 *    A mismatch is a 401 and is logged, never processed.
 *  - The raw body is persisted before anything parses it, so a processing bug
 *    never loses an event.
 *  - Duplicate X-Shopify-Webhook-Id values are suppressed by a unique index,
 *    which is what makes Shopify's aggressive retries safe.
 *  - A 200 is returned as soon as the event is stored. Processing happens after
 *    the acknowledgement so Shopify never retries because of our latency.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic") ?? "unknown";
  const eventId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();

  const valid = verifyWebhookHmac(raw, hmac);
  if (!valid) {
    log.warn("webhook signature rejected", { topic, ip: req.headers.get("x-forwarded-for") });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const [store] = await db.select().from(stores).limit(1);
  if (!store) return NextResponse.json({ error: "no store" }, { status: 500 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed body is stored and dead-lettered rather than crashing the receiver.
    await db
      .insert(webhookEvents)
      .values({
        storeId: store.id,
        topic,
        externalEventId: eventId,
        rawPayload: { raw: raw.slice(0, 10000) } as never,
        signatureValid: true,
        processingStatus: "dead_lettered",
        error: "invalid JSON",
      })
      .onConflictDoNothing();
    return NextResponse.json({ ok: true, note: "stored as dead letter" });
  }

  const inserted = await db
    .insert(webhookEvents)
    .values({
      storeId: store.id,
      topic,
      externalEventId: eventId,
      rawPayload: payload as never,
      signatureValid: true,
      processingStatus: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  if (inserted.length === 0) {
    // Already seen. Shopify is retrying; acknowledge and do nothing.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const eventRowId = inserted[0]!.id;

  // Processing is intentionally after the durable write and kept small. Heavy
  // work belongs in the sync job, which is idempotent over the same records.
  void (async () => {
    try {
      if (topic.startsWith("orders/") || topic.startsWith("fulfillments/") || topic.startsWith("refunds/")) {
        const order = (payload as { order?: ShopifyOrder }).order ?? (payload as ShopifyOrder);
        if (order && typeof order.id === "number") {
          const orderId = await upsertOrder({ storeId: store.id }, order);
          await computeOrderEconomics({ storeId: store.id }, orderId);
        } else if ((payload as { order_id?: number }).order_id) {
          const [existing] = await db
            .select({ id: shopOrders.id })
            .from(shopOrders)
            .where(eq(shopOrders.shopifyOrderId, String((payload as { order_id: number }).order_id)))
            .limit(1);
          if (existing) await computeOrderEconomics({ storeId: store.id }, existing.id);
        }
      }
      await db
        .update(webhookEvents)
        .set({ processingStatus: "processed", processedAt: new Date() })
        .where(eq(webhookEvents.id, eventRowId));
    } catch (err) {
      await db
        .update(webhookEvents)
        .set({ processingStatus: "failed", error: (err as Error).message })
        .where(eq(webhookEvents.id, eventRowId));
      log.error("webhook processing failed", { topic, error: (err as Error).message });
    }
  })();

  return NextResponse.json({ ok: true });
}
