import "server-only";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  detectedSignals,
  shopOrders,
  shopFulfillments,
  shopVariants,
  customerSignals,
  costRecords,
  orderEconomics,
} from "@/lib/db/schema";
import { storeSummary, skuPerformance, windowOf } from "@/lib/metrics";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Scope } from "@/lib/db/scoped";

/**
 * Deterministic detection. Pure arithmetic over records, no model involvement.
 *
 * The output is a list of signals with evidence attached. Only signals - never
 * raw metrics - are handed to the analyst agent, which keeps the token cost
 * bounded and keeps a quiet week from invoking a model at all.
 */

export type Signal = {
  code: string;
  severity: "info" | "warning" | "critical";
  title: string;
  evidence: Record<string, unknown>;
};

export type Thresholds = {
  minConversionRate: number;
  maxRefundRate: number;
  minContributionMarginBps: number;
  maxDaysToFulfil: number;
  maxDaysNoTracking: number;
  lowStockUnits: number;
  minOrdersForJudgement: number;
  repeatedComplaintCount: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  minConversionRate: 0.008,
  maxRefundRate: 0.06,
  minContributionMarginBps: 1500,
  maxDaysToFulfil: 3,
  maxDaysNoTracking: 2,
  lowStockUnits: 10,
  minOrdersForJudgement: 10,
  repeatedComplaintCount: 3,
};

export async function runDetection(
  scope: Pick<Scope, "storeId">,
  days = 14,
): Promise<Signal[]> {
  const t = DEFAULT_THRESHOLDS;
  const w = windowOf(days);
  const [summary, skus, business] = await Promise.all([
    storeSummary(scope, w),
    skuPerformance(scope, w),
    getSetting(scope, "business_defaults"),
  ]);

  const signals: Signal[] = [];
  const enough = summary.orders >= t.minOrdersForJudgement;

  /* ---- Conversion ---- */
  if (summary.sessions > 300 && summary.conversionRate != null && summary.conversionRate < t.minConversionRate) {
    signals.push({
      code: "conversion_below_floor",
      severity: "warning",
      title: `Conversion rate ${(summary.conversionRate * 100).toFixed(2)}% over ${days} days`,
      evidence: {
        sessions: summary.sessions,
        orders: summary.orders,
        threshold: `${(t.minConversionRate * 100).toFixed(2)}%`,
        window: w,
      },
    });
  }
  if (summary.sessions === 0) {
    signals.push({
      code: "missing_traffic_data",
      severity: "info",
      title: "No session data, so conversion rate cannot be computed",
      evidence: {
        note: "The Admin API does not expose sessions. Enter them on the Command Center, or connect analytics.",
      },
    });
  }

  /* ---- Profit ---- */
  if (enough && summary.contributionProfitCents < 0) {
    signals.push({
      code: "contribution_negative",
      severity: "critical",
      title: `Contribution profit is negative: ${(summary.contributionProfitCents / 100).toFixed(2)} over ${days} days`,
      evidence: {
        revenueCents: summary.revenueCents,
        cogsCents: summary.cogsCents,
        adSpendCents: summary.adSpendCents,
        refundCents: summary.refundCents,
      },
    });
  }
  if (enough && summary.cacCents > summary.breakEvenCacCents && summary.breakEvenCacCents > 0) {
    signals.push({
      code: "cac_above_breakeven",
      severity: "critical",
      title: `CAC $${(summary.cacCents / 100).toFixed(2)} exceeds break-even CAC $${(summary.breakEvenCacCents / 100).toFixed(2)}`,
      evidence: {
        adSpendCents: summary.adSpendCents,
        orders: summary.orders,
        roas: summary.roas,
        note: "Every additional order at this cost loses money before refunds.",
      },
    });
  }
  if (enough && summary.refundRate > t.maxRefundRate) {
    signals.push({
      code: "refund_rate_high",
      severity: "warning",
      title: `Refund rate ${(summary.refundRate * 100).toFixed(1)}% is above the ${(t.maxRefundRate * 100).toFixed(0)}% threshold`,
      evidence: { refundCents: summary.refundCents, revenueCents: summary.revenueCents },
    });
  }
  if (enough && summary.grossMarginBps < business.minGrossMarginBps) {
    signals.push({
      code: "margin_below_target",
      severity: "warning",
      title: `Gross margin ${(summary.grossMarginBps / 100).toFixed(1)}% is below your ${(business.minGrossMarginBps / 100).toFixed(0)}% floor`,
      evidence: { revenueCents: summary.revenueCents, cogsCents: summary.cogsCents },
    });
  }

  /* ---- Per SKU ---- */
  for (const s of skus) {
    if (s.orders < 3) continue;
    if (s.revenue > 0 && s.contribution < 0) {
      signals.push({
        code: "sku_contribution_negative",
        severity: "critical",
        title: `${s.sku ?? s.title} is revenue-positive but contribution-negative`,
        evidence: {
          sku: s.sku,
          revenueCents: s.revenue,
          contributionCents: s.contribution,
          orders: s.orders,
          usesEstimatedCosts: s.estimatedInputs,
        },
      });
    }
    if (s.revenue > 0 && s.refunds / s.revenue > t.maxRefundRate * 1.5) {
      signals.push({
        code: "sku_refund_rate_high",
        severity: "warning",
        title: `${s.sku ?? s.title} refund rate ${((s.refunds / s.revenue) * 100).toFixed(1)}%`,
        evidence: { sku: s.sku, refundCents: s.refunds, revenueCents: s.revenue },
      });
    }
  }

  /* ---- Fulfilment and shipping ---- */
  const stale = await db
    .select({
      id: shopOrders.id,
      orderNumber: shopOrders.orderNumber,
      paidAt: shopOrders.paidAt,
      totalCents: shopOrders.totalCents,
    })
    .from(shopOrders)
    .where(
      and(
        eq(shopOrders.storeId, scope.storeId),
        isNull(shopOrders.cancelledAt),
        sql`${shopOrders.fulfillmentStatus} is distinct from 'fulfilled'`,
        sql`${shopOrders.paidAt} < now() - interval '${sql.raw(String(t.maxDaysToFulfil))} days'`,
      ),
    )
    .limit(50);

  if (stale.length > 0) {
    signals.push({
      code: "orders_unfulfilled",
      severity: stale.length > 3 ? "critical" : "warning",
      title: `${stale.length} paid order(s) unfulfilled for more than ${t.maxDaysToFulfil} days`,
      evidence: {
        orders: stale.slice(0, 10).map((o) => ({
          order: o.orderNumber,
          paidAt: o.paidAt,
          valueCents: o.totalCents,
        })),
      },
    });
  }

  const noTracking = await db
    .select({ id: shopFulfillments.id, orderId: shopFulfillments.orderId, shippedAt: shopFulfillments.shippedAt })
    .from(shopFulfillments)
    .where(
      and(
        eq(shopFulfillments.storeId, scope.storeId),
        isNull(shopFulfillments.trackingNumber),
        sql`${shopFulfillments.shippedAt} < now() - interval '${sql.raw(String(t.maxDaysNoTracking))} days'`,
      ),
    )
    .limit(50);

  if (noTracking.length > 0) {
    signals.push({
      code: "fulfilments_missing_tracking",
      severity: "warning",
      title: `${noTracking.length} fulfilment(s) marked shipped with no tracking number`,
      evidence: {
        count: noTracking.length,
        note: "A fulfilment with no tracking after two days usually means a label was printed and the parcel was never handed over.",
      },
    });
  }

  /* ---- Inventory ---- */
  const lowStock = await db
    .select({ sku: shopVariants.sku, qty: shopVariants.inventoryQuantity, title: shopVariants.title })
    .from(shopVariants)
    .where(
      and(
        eq(shopVariants.storeId, scope.storeId),
        sql`${shopVariants.inventoryQuantity} is not null`,
        sql`${shopVariants.inventoryQuantity} <= ${t.lowStockUnits}`,
      ),
    )
    .limit(25);

  if (lowStock.length > 0) {
    signals.push({
      code: "inventory_low",
      severity: "warning",
      title: `${lowStock.length} variant(s) at or below ${t.lowStockUnits} units`,
      evidence: { variants: lowStock },
    });
  }

  /* ---- Supplier cost drift ---- */
  const recentCosts = await db
    .select()
    .from(costRecords)
    .where(and(eq(costRecords.storeId, scope.storeId), eq(costRecords.costType, "supplier_unit")))
    .orderBy(desc(costRecords.effectiveFrom))
    .limit(20);

  const bySku = new Map<string, typeof recentCosts>();
  for (const c of recentCosts) {
    const key = c.scopeValue ?? "global";
    bySku.set(key, [...(bySku.get(key) ?? []), c]);
  }
  for (const [sku, records] of bySku) {
    if (records.length < 2) continue;
    const [latest, previous] = records;
    if (!latest?.amountCents || !previous?.amountCents) continue;
    const delta = (latest.amountCents - previous.amountCents) / previous.amountCents;
    if (delta > 0.08) {
      signals.push({
        code: "supplier_cost_increase",
        severity: delta > 0.2 ? "critical" : "warning",
        title: `Product cost for ${sku} rose ${(delta * 100).toFixed(1)}%`,
        evidence: {
          sku,
          fromCents: previous.amountCents,
          toCents: latest.amountCents,
          effectiveFrom: latest.effectiveFrom,
        },
      });
    }
  }

  /* ---- Repeated customer complaints ---- */
  const themes = await db
    .select({
      theme: customerSignals.theme,
      count: sql<number>`count(*)::int`,
      kind: sql<string>`min(${customerSignals.kind})`,
    })
    .from(customerSignals)
    .where(
      and(
        eq(customerSignals.storeId, scope.storeId),
        gte(customerSignals.occurredAt, new Date(Date.now() - days * 86400_000)),
      ),
    )
    .groupBy(customerSignals.theme)
    .having(sql`count(*) >= ${t.repeatedComplaintCount}`);

  for (const th of themes) {
    signals.push({
      code: "repeated_customer_objection",
      severity: "warning",
      title: `"${th.theme}" raised ${th.count} times in ${days} days`,
      evidence: { theme: th.theme, count: th.count, kind: th.kind },
    });
  }

  /* ---- Data completeness ---- */
  const [estimatedShare] = await db
    .select({
      total: sql<number>`count(*)::int`,
      estimated: sql<number>`count(*) filter (where ${orderEconomics.hasEstimatedInputs})::int`,
    })
    .from(orderEconomics)
    .where(eq(orderEconomics.storeId, scope.storeId));

  if ((estimatedShare?.total ?? 0) > 0 && (estimatedShare!.estimated / estimatedShare!.total) > 0.5) {
    signals.push({
      code: "costs_mostly_estimated",
      severity: "info",
      title: "More than half of orders are costed from estimates",
      evidence: {
        totalOrders: estimatedShare!.total,
        estimatedOrders: estimatedShare!.estimated,
        note: "Profit figures are directional until real supplier invoices are entered.",
      },
    });
  }

  /* ---- Persist ---- */
  for (const s of signals) {
    await db.insert(detectedSignals).values({
      storeId: scope.storeId,
      code: s.code,
      severity: s.severity,
      title: s.title,
      evidence: s.evidence as never,
      windowStart: w.from,
      windowEnd: w.to,
    });
  }

  await audit(scope, {
    actorType: "system",
    actionType: "detection.run",
    metadata: { signalCount: signals.length, days },
  });

  return signals;
}

export async function openSignals(scope: Pick<Scope, "storeId">, limit = 40) {
  return db
    .select()
    .from(detectedSignals)
    .where(and(eq(detectedSignals.storeId, scope.storeId), isNull(detectedSignals.resolvedAt)))
    .orderBy(desc(detectedSignals.detectedAt))
    .limit(limit);
}
