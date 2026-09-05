import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { recommendations, detectedSignals, customerSignals, stackItems } from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/claude";
import { analystOutputSchema, stackOutputSchema } from "@/lib/ai/schemas";
import { assertWritesAllowed } from "@/lib/killswitch";
import { runDetection } from "@/lib/detect";
import { storeSummary, skuPerformance, windowOf } from "@/lib/metrics";
import { getSetting } from "@/lib/settings";
import { scanPayload } from "@/lib/compliance";
import { audit } from "@/lib/audit";
import type { Scope } from "@/lib/db/scoped";

const SYSTEM = `You are the operations analyst for a small US Shopify store. You interpret signals that a deterministic detector has already computed, and you propose what to do about them.

HARD RULES
1. You are given signals and aggregates. You may not invent a number that is not in them. If you need a figure you were not given, say so in missingData rather than estimating it.
2. Financial impact is a range in integer cents, and it must be derivable from the figures supplied. If it is not derivable, use null and explain why in missingData. A made-up impact figure is worse than none, because the operator will act on it.
3. Every recommendation needs evidence entries that quote the actual supplied figures.
4. requiresApproval must be true for anything that changes the store, contacts a customer, spends money, changes a price, changes a supplier, or writes to Shopify. Only pure internal notes may be false.
5. proposedAction.payload must be a concrete, executable payload for the named kind, or null. Never guess a Shopify resource id you were not given.
6. Confidence is calibrated: below 0.5 when the sample is small or the costs are estimated, above 0.8 only when the data is complete and the effect is unambiguous.
7. When the honest answer is "there is not enough data to decide yet", that is a valid and useful recommendation in the "data" category. Say what to collect and how long it will take.
8. Do not recommend anything that requires fake urgency, fake reviews, fake discounts, or a claim the store cannot substantiate.`;

export async function runAnalyst(scope: Scope, days = 14): Promise<number> {
  await assertWritesAllowed(scope);

  const w = windowOf(days);
  const [signals, summary, skus, business] = await Promise.all([
    runDetection(scope, days),
    storeSummary(scope, w),
    skuPerformance(scope, w),
    getSetting(scope, "business_defaults"),
  ]);

  const complaints = await db
    .select()
    .from(customerSignals)
    .where(eq(customerSignals.storeId, scope.storeId))
    .orderBy(desc(customerSignals.occurredAt))
    .limit(40);

  if (signals.length === 0 && summary.orders === 0) {
    // Nothing has happened. A model call here would burn tokens to say so.
    return 0;
  }

  const prompt = `WINDOW: last ${days} days (${w.from} to ${w.to})

STORE AGGREGATES (integer cents unless noted)
${JSON.stringify(summary, null, 2)}

OPERATOR TARGETS
Minimum gross margin: ${(business.minGrossMarginBps / 100).toFixed(1)}%
Target price: ${business.targetPriceCents}
Max delivery days: ${business.maxShippingDays}
Daily ad budget: ${business.dailyAdBudgetCents}

DETECTED SIGNALS (deterministic, already verified against records)
${JSON.stringify(signals, null, 2)}

SKU PERFORMANCE
${JSON.stringify(skus, null, 2)}

RECENT CUSTOMER SIGNAL THEMES
${JSON.stringify(complaints.map((c) => ({ theme: c.theme, kind: c.kind, sentiment: c.sentiment })), null, 2)}

TASK
Produce up to 10 ranked recommendations. Cover, where the data supports it: what is hurting conversion, what is harming profit, which products or variants to pause or review, emerging supplier issues, the customer objections repeating most often, which product-page sections need work, which ad angles to test, which offers could lift conversion, which customers need proactive contact about shipping delays, and what data is missing before a decision can responsibly be made.

Return JSON:
{
  "recommendations": [{
    "category": "conversion"|"profit"|"product"|"supplier"|"support"|"content"|"ads"|"offer"|"data",
    "title": string, "body": string,
    "evidence": [{"label": string, "detail": string}],
    "financialImpactMinCents": number|null, "financialImpactMaxCents": number|null,
    "confidence": 0-1, "riskLevel": "low"|"medium"|"high"|"critical",
    "proposedAction": {"kind": "shopify_update_product_description"|"shopify_create_page"|"shopify_create_discount"|"shopify_update_product_seo"|"internal_note"|"manual_task", "payload": object, "humanSummary": string} | null,
    "requiresApproval": boolean, "rollbackPlan": string, "missingData": string[]
  }],
  "summary": string
}`;

  const result = await generateStructured({
    scope,
    agentName: "command_center_analyst",
    tier: "frontier",
    system: SYSTEM,
    prompt,
    schema: analystOutputSchema,
    maxTokens: 12000,
    temperature: 0.3,
    inputRefs: { days, signalCount: signals.length },
  });

  let written = 0;
  for (const r of result.data.recommendations) {
    const findings = scanPayload(r.proposedAction?.payload ?? {});
    // A recommendation whose payload trips the compliance scan is stored with
    // the finding attached and forced to require approval.
    await db.insert(recommendations).values({
      storeId: scope.storeId,
      agentRunId: result.agentRunId,
      category: r.category,
      title: r.title,
      body: r.body,
      evidence: [
        ...r.evidence,
        ...findings.map((f) => ({ label: `compliance:${f.category}`, detail: `${f.match} — ${f.reason}` })),
      ] as never,
      financialImpactMinCents: r.financialImpactMinCents,
      financialImpactMaxCents: r.financialImpactMaxCents,
      confidence: r.confidence.toFixed(3),
      riskLevel: findings.length > 0 ? "high" : r.riskLevel,
      proposedAction: (r.proposedAction ?? null) as never,
      requiresApproval: r.requiresApproval || findings.length > 0 || r.proposedAction != null,
      rollbackPlan: r.rollbackPlan,
      missingData: r.missingData as never,
      status: "open",
    });
    written++;
  }

  await audit(scope, {
    actorType: "agent",
    actorId: result.agentRunId,
    actionType: "analyst.run",
    afterState: { recommendations: written, signals: signals.length, summary: result.data.summary },
  });

  return written;
}

/* ------------------------------------------------------------------ */
/* Recommended store stack                                             */
/* ------------------------------------------------------------------ */

const STACK_SYSTEM = `You are advising a first-time Shopify operator on the minimum app stack for one product.

HARD RULES
1. Recommend as few apps as possible. Every app costs money, adds scripts to the storefront, slows mobile checkout, and creates another integration that can break. If a category is not needed for this product, put it in "omitted" with the reason instead of recommending something.
2. Never recommend a subscription app unless the product genuinely supports repeat purchase.
3. Pricing changes constantly. Give the estimate you believe to be roughly right and say in "risks" that the operator must confirm current pricing on the listing before installing. Never state a price as certain.
4. dataPermissions must describe what customer data the app would receive. Be specific and honest about it.
5. installUrl may be an apps.shopify.com search or listing URL, or null. Never invent a URL you are not confident exists.
6. Prioritise: store speed, low monthly cost, simple workflows, minimal conflicts between apps, privacy, and mobile checkout performance.`;

export async function recommendStack(scope: Scope, productContext: string): Promise<number> {
  await assertWritesAllowed(scope);
  const business = await getSetting(scope, "business_defaults");

  const result = await generateStructured({
    scope,
    agentName: "store_stack",
    tier: "frontier",
    system: STACK_SYSTEM,
    prompt: `STORE
Market: ${business.targetCountry}
Price point: $${(business.targetPriceCents / 100).toFixed(2)}
Delivery window: up to ${business.maxShippingDays} days
Launch budget: $${(business.launchBudgetCents / 100).toFixed(2)}
Monthly budget for apps should stay under $80 unless something is genuinely load-bearing.

PRODUCT
${productContext}

CATEGORIES TO EVALUATE
supplier/fulfilment connection, product import, order tracking, reviews, email/SMS, customer support, analytics, conversion-rate optimisation, bundles/upsells, privacy and cookie consent, fraud prevention, returns management, subscriptions (only if the product supports repeat purchase).

Return JSON:
{
  "apps": [{"category": string, "appName": string, "whyNeeded": string, "essentialBeforeLaunch": boolean, "freePlanAvailable": boolean, "estimatedMonthlyCents": number|null, "dataPermissions": string[], "setupSteps": string[], "risks": string[], "alternatives": string[], "installUrl": string|null}],
  "omitted": [{"category": string, "reason": string}],
  "totalMonthlyEstimateCents": number,
  "notes": string
}`,
    schema: stackOutputSchema,
    maxTokens: 9000,
    inputRefs: { productContext: productContext.slice(0, 200) },
  });

  await db.delete(stackItems).where(eq(stackItems.storeId, scope.storeId));

  for (const app of result.data.apps) {
    await db.insert(stackItems).values({
      storeId: scope.storeId,
      agentRunId: result.agentRunId,
      category: app.category,
      appName: app.appName,
      whyNeeded: app.whyNeeded,
      essentialBeforeLaunch: app.essentialBeforeLaunch,
      freePlanAvailable: app.freePlanAvailable,
      estimatedMonthlyCents: app.estimatedMonthlyCents,
      dataPermissions: app.dataPermissions as never,
      setupSteps: app.setupSteps as never,
      risks: [...app.risks, "Confirm current pricing and permissions on the App Store listing before installing."] as never,
      alternatives: app.alternatives as never,
      installUrl: app.installUrl,
      status: "recommended",
    });
  }

  await audit(scope, {
    actorType: "agent",
    actorId: result.agentRunId,
    actionType: "stack.recommended",
    afterState: { apps: result.data.apps.length, omitted: result.data.omitted, notes: result.data.notes },
  });

  return result.data.apps.length;
}

export async function openRecommendations(scope: Pick<Scope, "storeId">) {
  return db
    .select()
    .from(recommendations)
    .where(eq(recommendations.storeId, scope.storeId))
    .orderBy(desc(recommendations.createdAt))
    .limit(50);
}

export async function recentSignals(scope: Pick<Scope, "storeId">) {
  return db
    .select()
    .from(detectedSignals)
    .where(eq(detectedSignals.storeId, scope.storeId))
    .orderBy(desc(detectedSignals.detectedAt))
    .limit(30);
}
