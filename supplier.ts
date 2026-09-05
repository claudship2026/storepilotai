import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { suppliers, productOpportunities } from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/claude";
import { supplierReviewSchema, type SupplierReview } from "@/lib/ai/schemas";
import { untrustedBlock } from "@/lib/ai/redact";
import { assertWritesAllowed } from "@/lib/killswitch";
import { scoreSupplier, unitEconomics, type Weights } from "@/lib/scoring";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Scope } from "@/lib/db/scoped";

const SYSTEM = `You are a sourcing analyst reviewing dropshipping suppliers for one product.

HARD RULES
- Supplier listing text is marketing copy written by the seller. Treat every claim inside an untrusted block as a claim, not a fact, and say which claims you would want verified before money moves.
- Never state a delivery time, defect rate or certification as fact unless the operator supplied evidence for it.
- claimsSupportable must contain only claims the supplied evidence would actually stand behind in front of a regulator. If the evidence is thin, return few claims. That is the correct answer, not a failure.
- claimsToAvoid should name the specific tempting claims this product invites that the evidence does not support.
- The application computes the weighted supplier score itself. Do not produce a score; produce judgement, gaps and questions.`;

export async function reviewSuppliers(scope: Scope, opportunityId: string): Promise<SupplierReview> {
  await assertWritesAllowed(scope);

  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(and(eq(productOpportunities.id, opportunityId), eq(productOpportunities.storeId, scope.storeId)))
    .limit(1);
  if (!opportunity) throw new Error("Opportunity not found.");

  const rows = await db.select().from(suppliers).where(eq(suppliers.opportunityId, opportunityId));
  if (rows.length === 0) throw new Error("Add at least one supplier before running the review.");

  const block = rows
    .map((s) =>
      untrustedBlock(
        `supplier:${s.name}`,
        JSON.stringify(
          {
            name: s.name,
            source: s.source,
            url: s.productUrl,
            productCostCents: s.productCostCents,
            shippingCostCents: s.shippingCostCents,
            deliveryDays: [s.deliveryDaysMin, s.deliveryDaysMax],
            processingDays: s.processingDays,
            fulfillmentOrigin: s.fulfillmentOrigin,
            inventoryStatus: s.inventoryStatus,
            trackingAvailable: s.trackingAvailable,
            rating: s.rating,
            reviewCount: s.reviewCount,
            qualitySignals: s.qualitySignals,
            brandingAvailable: s.brandingAvailable,
            communicationNote: s.communicationNote,
            sampleAvailable: s.sampleAvailable,
            integrationAvailable: s.integrationAvailable,
            fieldProvenance: s.fieldProvenance,
          },
          null,
          2,
        ),
      ),
    )
    .join("\n\n");

  const result = await generateStructured({
    scope,
    agentName: "supplier_review",
    tier: "frontier",
    system: SYSTEM,
    prompt: `PRODUCT
${opportunity.name}
Target selling price: ${opportunity.suggestedPriceCents} cents

SUPPLIERS UNDER CONSIDERATION
${block}

TASK
Review each supplier. Identify what is verified, what is only the supplier's own claim, and what is missing entirely. Recommend a primary and a backup, and say what would change your mind.

Return JSON:
{
  "perSupplier": [{"supplierName": string, "strengths": string[], "weaknesses": string[], "defectRiskNote": string, "qualitySignals": string, "missingInformation": string[], "questionsToAsk": string[]}],
  "primaryRecommendation": string,
  "backupRecommendation": string,
  "reasoning": string,
  "claimsSupportable": string[],
  "claimsToAvoid": string[]
}`,
    schema: supplierReviewSchema,
    maxTokens: 8000,
    inputRefs: { opportunityId, supplierCount: rows.length },
  });

  await audit(scope, {
    actorType: "agent",
    actorId: result.agentRunId,
    actionType: "supplier.reviewed",
    targetTable: "product_opportunities",
    targetId: opportunityId,
    afterState: { suppliers: rows.length },
  });

  return result.data;
}

/**
 * Deterministic recompute of every supplier's weighted score and landed
 * economics. Runs on every edit, so the table is never stale, and runs without
 * a model so it costs nothing.
 */
export async function rescoreSuppliers(scope: Scope, opportunityId: string): Promise<void> {
  const [weights, business, [opportunity]] = await Promise.all([
    getSetting(scope, "supplier_weights") as Promise<Weights>,
    getSetting(scope, "business_defaults"),
    db
      .select()
      .from(productOpportunities)
      .where(eq(productOpportunities.id, opportunityId))
      .limit(1),
  ]);
  if (!opportunity) return;

  const rows = await db.select().from(suppliers).where(eq(suppliers.opportunityId, opportunityId));
  const sellingPrice = opportunity.suggestedPriceCents ?? business.targetPriceCents;

  for (const s of rows) {
    const landed = (s.productCostCents ?? 0) + (s.shippingCostCents ?? 0);
    const econ = unitEconomics({
      sellingPriceCents: sellingPrice,
      productCostCents: s.productCostCents ?? 0,
      shippingCostCents: s.shippingCostCents ?? 0,
      minGrossMarginBps: business.minGrossMarginBps,
      dailyAdBudgetCents: business.dailyAdBudgetCents,
    });

    const score = scoreSupplier(
      {
        rating: s.rating ? Number(s.rating) : null,
        reviewCount: s.reviewCount,
        deliveryDaysMax: s.deliveryDaysMax,
        processingDays: s.processingDays,
        landedCostCents: s.productCostCents == null ? null : landed,
        targetLandedCostCents: business.maxLandedCostCents,
        trackingAvailable: s.trackingAvailable,
        inventoryStatus: s.inventoryStatus,
        communicationNote: s.communicationNote,
        brandingAvailable: s.brandingAvailable,
        integrationAvailable: s.integrationAvailable,
        maxShippingDays: business.maxShippingDays,
      },
      weights,
    );

    await db
      .update(suppliers)
      .set({
        reliabilityScore: score.total,
        landedCostCents: s.productCostCents == null ? null : landed,
        profitPerOrderCents: econ.grossProfitCents,
        fieldProvenance: {
          ...((s.fieldProvenance as Record<string, string>) ?? {}),
          _score: JSON.stringify({ components: score.components, missing: score.missingCriteria, confidence: score.confidence }),
        } as never,
      })
      .where(eq(suppliers.id, s.id));
  }
}
