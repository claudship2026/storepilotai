import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  shopOrders,
  shopOrderLines,
  shopFulfillments,
  shopRefunds,
  shopProducts,
  shopVariants,
  costRecords,
  adSpendRecords,
  orderEconomics,
  dailyMetrics,
  trafficRecords,
} from "@/lib/db/schema";
import { fetchOrders, fetchProducts, shopifyConfigured, type ShopifyOrder } from "@/lib/shopify";
import { audit } from "@/lib/audit";
import { log } from "@/lib/logger";
import type { Scope } from "@/lib/db/scoped";

const money = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const day = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/**
 * Pulls orders and products from Shopify into the local mirror. Idempotent:
 * upserts are keyed on the Shopify id, so re-running produces identical state
 * and no duplicate side effects.
 */
export async function syncFromShopify(
  scope: Pick<Scope, "storeId">,
  lookbackDays = 60,
): Promise<{ orders: number; products: number }> {
  if (!shopifyConfigured()) return { orders: 0, products: 0 };

  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
  const [orders, products] = await Promise.all([fetchOrders(since), fetchProducts()]);

  for (const p of products) {
    const [row] = await db
      .insert(shopProducts)
      .values({
        storeId: scope.storeId,
        shopifyProductId: String(p.id),
        title: p.title,
        handle: p.handle,
        status: p.status,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [shopProducts.storeId, shopProducts.shopifyProductId],
        set: { title: p.title, handle: p.handle, status: p.status, updatedAt: new Date() },
      })
      .returning({ id: shopProducts.id });

    for (const v of p.variants) {
      await db
        .insert(shopVariants)
        .values({
          storeId: scope.storeId,
          productId: row!.id,
          shopifyVariantId: String(v.id),
          sku: v.sku,
          title: v.title,
          priceCents: money(v.price),
          inventoryQuantity: v.inventory_quantity,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [shopVariants.storeId, shopVariants.shopifyVariantId],
          set: {
            sku: v.sku,
            title: v.title,
            priceCents: money(v.price),
            inventoryQuantity: v.inventory_quantity,
            updatedAt: new Date(),
          },
        });
    }
  }

  for (const o of orders) await upsertOrder(scope, o);

  log.info("shopify sync complete", { orders: orders.length, products: products.length });
  return { orders: orders.length, products: products.length };
}

export async function upsertOrder(scope: Pick<Scope, "storeId">, o: ShopifyOrder): Promise<string> {
  const [row] = await db
    .insert(shopOrders)
    .values({
      storeId: scope.storeId,
      shopifyOrderId: String(o.id),
      orderNumber: o.name,
      financialStatus: o.financial_status,
      fulfillmentStatus: o.fulfillment_status,
      currency: o.currency,
      subtotalCents: money(o.subtotal_price),
      shippingCents: money(o.total_shipping_price_set?.shop_money.amount),
      taxCents: money(o.total_tax),
      discountCents: money(o.total_discounts),
      totalCents: money(o.total_price),
      shippingCountry: o.shipping_address?.country_code ?? null,
      // A one-way hash. The customer's identity never enters this database.
      customerRef: o.customer?.id
        ? createHash("sha256").update(`${scope.storeId}:${o.customer.id}`).digest("hex").slice(0, 24)
        : null,
      placedAt: new Date(o.created_at),
      paidAt: o.processed_at ? new Date(o.processed_at) : null,
      cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [shopOrders.storeId, shopOrders.shopifyOrderId],
      set: {
        financialStatus: o.financial_status,
        fulfillmentStatus: o.fulfillment_status,
        totalCents: money(o.total_price),
        cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: shopOrders.id });

  const orderId = row!.id;

  for (const li of o.line_items) {
    await db
      .insert(shopOrderLines)
      .values({
        storeId: scope.storeId,
        orderId,
        shopifyLineId: String(li.id),
        sku: li.sku,
        title: li.title,
        variantTitle: li.variant_title,
        quantity: li.quantity,
        unitPriceCents: money(li.price),
        totalCents: money(li.price) * li.quantity,
      })
      .onConflictDoNothing({ target: [shopOrderLines.storeId, shopOrderLines.shopifyLineId] });
  }

  for (const f of o.fulfillments ?? []) {
    await db
      .insert(shopFulfillments)
      .values({
        storeId: scope.storeId,
        orderId,
        shopifyFulfillmentId: String(f.id),
        status: f.status,
        trackingCompany: f.tracking_company,
        trackingNumber: f.tracking_number,
        shippedAt: new Date(f.created_at),
      })
      .onConflictDoUpdate({
        target: [shopFulfillments.storeId, shopFulfillments.shopifyFulfillmentId],
        set: { status: f.status, trackingCompany: f.tracking_company, trackingNumber: f.tracking_number },
      });
  }

  for (const r of o.refunds ?? []) {
    const amount = (r.transactions ?? []).reduce((a, t) => a + money(t.amount), 0);
    await db
      .insert(shopRefunds)
      .values({
        storeId: scope.storeId,
        orderId,
        shopifyRefundId: String(r.id),
        amountCents: amount,
        reason: r.note,
        refundedAt: new Date(r.created_at),
      })
      .onConflictDoNothing({ target: [shopRefunds.storeId, shopRefunds.shopifyRefundId] });
  }

  await computeOrderEconomics(scope, orderId);
  return orderId;
}

/* ------------------------------------------------------------------ */
/* Contribution profit                                                 */
/* ------------------------------------------------------------------ */

type CostLookup = {
  supplierUnit: (sku: string | null) => { cents: number; id: string | null; estimated: boolean };
  inboundShipping: (sku: string | null) => { cents: number; id: string | null; estimated: boolean };
  packaging: () => { cents: number; id: string | null; estimated: boolean };
  feeRateBps: number;
  feeFixedCents: number;
};

async function buildCostLookup(storeId: string): Promise<CostLookup> {
  const rows = await db
    .select()
    .from(costRecords)
    .where(eq(costRecords.storeId, storeId))
    .orderBy(desc(costRecords.effectiveFrom));

  // Most recent effective record wins, SKU scope before global.
  const pick = (type: string, sku: string | null) => {
    const bySku = sku ? rows.find((r) => r.costType === type && r.scopeValue === sku) : undefined;
    const global = rows.find((r) => r.costType === type && (r.scopeType === "global" || !r.scopeValue));
    const chosen = bySku ?? global;
    return {
      cents: chosen?.amountCents ?? 0,
      id: chosen?.id ?? null,
      estimated: chosen ? chosen.provenance !== "verified" : true,
    };
  };

  const rate = rows.find((r) => r.costType === "transaction_fee_rate");
  const fixed = rows.find((r) => r.costType === "transaction_fee_fixed");

  return {
    supplierUnit: (sku) => pick("supplier_unit", sku),
    inboundShipping: (sku) => pick("inbound_shipping", sku),
    packaging: () => pick("packaging", null),
    feeRateBps: rate?.rateBps ?? 290,
    feeFixedCents: fixed?.amountCents ?? 30,
  };
}

/**
 * Deterministic. Every component is stored individually, along with the exact
 * cost record ids used, so any historical figure can be reproduced and audited
 * rather than merely displayed.
 */
export async function computeOrderEconomics(
  scope: Pick<Scope, "storeId">,
  orderId: string,
): Promise<void> {
  const [order] = await db
    .select()
    .from(shopOrders)
    .where(and(eq(shopOrders.id, orderId), eq(shopOrders.storeId, scope.storeId)))
    .limit(1);
  if (!order) return;

  const [lines, refunds, costs] = await Promise.all([
    db.select().from(shopOrderLines).where(eq(shopOrderLines.orderId, orderId)),
    db.select().from(shopRefunds).where(eq(shopRefunds.orderId, orderId)),
    buildCostLookup(scope.storeId),
  ]);

  let productCost = 0;
  let inbound = 0;
  let estimated = false;
  const used: string[] = [];

  for (const line of lines) {
    const unit = costs.supplierUnit(line.sku);
    const ship = costs.inboundShipping(line.sku);
    productCost += unit.cents * line.quantity;
    inbound += ship.cents * line.quantity;
    estimated ||= unit.estimated || ship.estimated;
    if (unit.id) used.push(unit.id);
    if (ship.id) used.push(ship.id);
  }

  const pack = costs.packaging();
  estimated ||= pack.estimated;
  if (pack.id) used.push(pack.id);

  const revenue = order.subtotalCents + order.shippingCents - order.discountCents;
  const fee = Math.round((order.totalCents * costs.feeRateBps) / 10000) + costs.feeFixedCents;
  const refundTotal = refunds.reduce((a, r) => a + r.amountCents, 0);
  const contribution = revenue - productCost - inbound - pack.cents - fee - refundTotal;

  await db
    .insert(orderEconomics)
    .values({
      storeId: scope.storeId,
      orderId,
      revenueCents: revenue,
      productCostCents: productCost,
      shippingCostCents: inbound,
      packagingCostCents: pack.cents,
      transactionFeeCents: fee,
      refundCents: refundTotal,
      contributionProfitCents: contribution,
      contributionMarginBps: revenue > 0 ? Math.round((contribution / revenue) * 10000) : 0,
      costRecordsUsed: [...new Set(used)] as never,
      hasEstimatedInputs: estimated,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orderEconomics.orderId],
      set: {
        revenueCents: revenue,
        productCostCents: productCost,
        shippingCostCents: inbound,
        packagingCostCents: pack.cents,
        transactionFeeCents: fee,
        refundCents: refundTotal,
        contributionProfitCents: contribution,
        contributionMarginBps: revenue > 0 ? Math.round((contribution / revenue) * 10000) : 0,
        costRecordsUsed: [...new Set(used)] as never,
        hasEstimatedInputs: estimated,
        computedAt: new Date(),
      },
    });
}

/* ------------------------------------------------------------------ */
/* Rollups                                                             */
/* ------------------------------------------------------------------ */

export async function rebuildDailyMetrics(
  scope: Pick<Scope, "storeId">,
  days = 60,
): Promise<number> {
  const from = new Date(Date.now() - days * 86400_000);

  const rows = await db
    .select({
      d: sql<string>`to_char(${shopOrders.paidAt}, 'YYYY-MM-DD')`,
      orders: sql<number>`count(distinct ${shopOrders.id})::int`,
      revenue: sql<number>`coalesce(sum(${orderEconomics.revenueCents}), 0)::int`,
      cogs: sql<number>`coalesce(sum(${orderEconomics.productCostCents} + ${orderEconomics.shippingCostCents} + ${orderEconomics.packagingCostCents}), 0)::int`,
      refunds: sql<number>`coalesce(sum(${orderEconomics.refundCents}), 0)::int`,
      contribution: sql<number>`coalesce(sum(${orderEconomics.contributionProfitCents}), 0)::int`,
    })
    .from(shopOrders)
    .leftJoin(orderEconomics, eq(orderEconomics.orderId, shopOrders.id))
    .where(and(eq(shopOrders.storeId, scope.storeId), gte(shopOrders.paidAt, from)))
    .groupBy(sql`1`);

  const spend = await db
    .select({
      d: sql<string>`${adSpendRecords.spendDate}::text`,
      spend: sql<number>`coalesce(sum(${adSpendRecords.spendCents}), 0)::int`,
    })
    .from(adSpendRecords)
    .where(and(eq(adSpendRecords.storeId, scope.storeId), gte(adSpendRecords.spendDate, day(from))))
    .groupBy(sql`1`);

  const traffic = await db
    .select()
    .from(trafficRecords)
    .where(and(eq(trafficRecords.storeId, scope.storeId), gte(trafficRecords.recordDate, day(from))));

  const spendByDay = new Map(spend.map((s) => [s.d, s.spend]));
  const sessionsByDay = new Map(traffic.map((t) => [t.recordDate, t.sessions]));
  const allDays = new Set<string>([...rows.map((r) => r.d), ...spendByDay.keys(), ...sessionsByDay.keys()]);

  let written = 0;
  for (const d of allDays) {
    if (!d) continue;
    const r = rows.find((x) => x.d === d);
    const adSpend = spendByDay.get(d) ?? 0;
    await db
      .insert(dailyMetrics)
      .values({
        storeId: scope.storeId,
        metricDate: d,
        grain: "store",
        grainValue: null,
        sessions: sessionsByDay.get(d) ?? null,
        orders: r?.orders ?? 0,
        units: 0,
        revenueCents: r?.revenue ?? 0,
        cogsCents: r?.cogs ?? 0,
        adSpendCents: adSpend,
        refundCents: r?.refunds ?? 0,
        contributionProfitCents: (r?.contribution ?? 0) - adSpend,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [dailyMetrics.storeId, dailyMetrics.metricDate, dailyMetrics.grain, dailyMetrics.grainValue],
        set: {
          sessions: sessionsByDay.get(d) ?? null,
          orders: r?.orders ?? 0,
          revenueCents: r?.revenue ?? 0,
          cogsCents: r?.cogs ?? 0,
          adSpendCents: adSpend,
          refundCents: r?.refunds ?? 0,
          contributionProfitCents: (r?.contribution ?? 0) - adSpend,
          computedAt: new Date(),
        },
      });
    written++;
  }

  await audit(scope, {
    actorType: "system",
    actionType: "metrics.rebuilt",
    metadata: { days: written },
  });
  return written;
}

/* ------------------------------------------------------------------ */
/* Read models for the Command Center                                  */
/* ------------------------------------------------------------------ */

export type Window = { from: string; to: string; days: number };

export function windowOf(days: number): Window {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400_000);
  return { from: day(from), to: day(to), days };
}

export async function storeSummary(scope: Pick<Scope, "storeId">, w: Window) {
  const [agg] = await db
    .select({
      orders: sql<number>`coalesce(sum(${dailyMetrics.orders}), 0)::int`,
      sessions: sql<number>`coalesce(sum(${dailyMetrics.sessions}), 0)::int`,
      revenue: sql<number>`coalesce(sum(${dailyMetrics.revenueCents}), 0)::int`,
      cogs: sql<number>`coalesce(sum(${dailyMetrics.cogsCents}), 0)::int`,
      adSpend: sql<number>`coalesce(sum(${dailyMetrics.adSpendCents}), 0)::int`,
      refunds: sql<number>`coalesce(sum(${dailyMetrics.refundCents}), 0)::int`,
      contribution: sql<number>`coalesce(sum(${dailyMetrics.contributionProfitCents}), 0)::int`,
    })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.storeId, scope.storeId),
        eq(dailyMetrics.grain, "store"),
        gte(dailyMetrics.metricDate, w.from),
        lte(dailyMetrics.metricDate, w.to),
      ),
    );

  const orders = agg?.orders ?? 0;
  const sessions = agg?.sessions ?? 0;
  const revenue = agg?.revenue ?? 0;
  const adSpend = agg?.adSpend ?? 0;
  const contribution = agg?.contribution ?? 0;
  const grossProfit = revenue - (agg?.cogs ?? 0);

  return {
    orders,
    sessions,
    revenueCents: revenue,
    cogsCents: agg?.cogs ?? 0,
    adSpendCents: adSpend,
    refundCents: agg?.refunds ?? 0,
    contributionProfitCents: contribution,
    aovCents: orders > 0 ? Math.round(revenue / orders) : 0,
    conversionRate: sessions > 0 ? orders / sessions : null,
    grossMarginBps: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) : 0,
    cacCents: orders > 0 ? Math.round(adSpend / orders) : 0,
    roas: adSpend > 0 ? revenue / adSpend : null,
    refundRate: revenue > 0 ? (agg?.refunds ?? 0) / revenue : 0,
    breakEvenCacCents: orders > 0 ? Math.round(grossProfit / orders) : 0,
  };
}

export async function skuPerformance(scope: Pick<Scope, "storeId">, w: Window) {
  return db
    .select({
      sku: shopOrderLines.sku,
      title: sql<string>`min(${shopOrderLines.title})`,
      units: sql<number>`coalesce(sum(${shopOrderLines.quantity}), 0)::int`,
      revenue: sql<number>`coalesce(sum(${shopOrderLines.totalCents}), 0)::int`,
      orders: sql<number>`count(distinct ${shopOrderLines.orderId})::int`,
      refunds: sql<number>`coalesce(sum(${orderEconomics.refundCents}), 0)::int`,
      contribution: sql<number>`coalesce(sum(${orderEconomics.contributionProfitCents}), 0)::int`,
      estimatedInputs: sql<boolean>`bool_or(${orderEconomics.hasEstimatedInputs})`,
    })
    .from(shopOrderLines)
    .innerJoin(shopOrders, eq(shopOrderLines.orderId, shopOrders.id))
    .leftJoin(orderEconomics, eq(orderEconomics.orderId, shopOrders.id))
    .where(
      and(
        eq(shopOrderLines.storeId, scope.storeId),
        gte(shopOrders.paidAt, new Date(w.from)),
      ),
    )
    .groupBy(shopOrderLines.sku)
    .orderBy(sql`3 desc`)
    .limit(50);
}

export async function dailySeries(scope: Pick<Scope, "storeId">, w: Window) {
  return db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.storeId, scope.storeId),
        eq(dailyMetrics.grain, "store"),
        gte(dailyMetrics.metricDate, w.from),
      ),
    )
    .orderBy(dailyMetrics.metricDate);
}
