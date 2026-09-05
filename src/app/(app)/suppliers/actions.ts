"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { suppliers, productDecisions, productOpportunities, storeBuilds } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { reviewSuppliers, rescoreSuppliers } from "@/lib/agents/supplier";
import { propose, decide } from "@/lib/approvals";
import { audit } from "@/lib/audit";

const cents = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  return s ? Math.round(Number(s) * 100) : null;
};
const num = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  return s ? Number(s) : null;
};
const bool = (v: FormDataEntryValue | null) => (v === "yes" ? true : v === "no" ? false : null);

export async function addSupplier(formData: FormData) {
  const scope = await requireScope();
  const opportunityId = String(formData.get("opportunityId"));

  const provenanceMap: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("prov_")) provenanceMap[k.slice(5)] = String(v);
  }

  await db.insert(suppliers).values({
    storeId: scope.storeId,
    opportunityId,
    name: String(formData.get("name")),
    source: String(formData.get("source") || "unknown"),
    productUrl: String(formData.get("productUrl") || "") || null,
    productCostCents: cents(formData.get("productCost")),
    shippingCostCents: cents(formData.get("shippingCost")),
    deliveryDaysMin: num(formData.get("deliveryDaysMin")),
    deliveryDaysMax: num(formData.get("deliveryDaysMax")),
    processingDays: num(formData.get("processingDays")),
    fulfillmentOrigin: String(formData.get("fulfillmentOrigin") || "") || null,
    inventoryStatus: String(formData.get("inventoryStatus") || "") || null,
    trackingAvailable: bool(formData.get("trackingAvailable")),
    rating: formData.get("rating") ? String(num(formData.get("rating"))) : null,
    reviewCount: num(formData.get("reviewCount")),
    qualitySignals: String(formData.get("qualitySignals") || "") || null,
    brandingAvailable: bool(formData.get("brandingAvailable")),
    communicationNote: String(formData.get("communicationNote") || "") || null,
    sampleAvailable: bool(formData.get("sampleAvailable")),
    integrationAvailable: String(formData.get("integrationAvailable") || "") || null,
    fieldProvenance: provenanceMap as never,
  });

  await rescoreSuppliers(scope, opportunityId);
  revalidatePath(`/suppliers/${opportunityId}`);
}

export async function removeSupplier(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("id"));
  const opportunityId = String(formData.get("opportunityId"));
  await db.delete(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.storeId, scope.storeId)));
  await rescoreSuppliers(scope, opportunityId);
  revalidatePath(`/suppliers/${opportunityId}`);
}

export async function runSupplierReview(formData: FormData) {
  const scope = await requireScope();
  const opportunityId = String(formData.get("opportunityId"));
  await rescoreSuppliers(scope, opportunityId);
  const review = await reviewSuppliers(scope, opportunityId);

  // Stored on the opportunity so the decision form can prefill the claim lists.
  const [row] = await db
    .select()
    .from(productOpportunities)
    .where(eq(productOpportunities.id, opportunityId))
    .limit(1);
  if (row) {
    await db
      .update(productOpportunities)
      .set({ analysis: { ...(row.analysis as object), supplierReview: review } as never })
      .where(eq(productOpportunities.id, opportunityId));
  }

  revalidatePath(`/suppliers/${opportunityId}`);
}

/**
 * The gate. Creates an approval request, then immediately records the operator's
 * approval, so the decision lands in the audit chain with the same shape as
 * every other change rather than being a special case.
 */
export async function approveProductForBuild(formData: FormData) {
  const scope = await requireScope();
  const opportunityId = String(formData.get("opportunityId"));

  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(and(eq(productOpportunities.id, opportunityId), eq(productOpportunities.storeId, scope.storeId)))
    .limit(1);
  if (!opportunity) throw new Error("Opportunity not found.");

  const primarySupplierId = String(formData.get("primarySupplierId") || "") || null;
  const backupSupplierId = String(formData.get("backupSupplierId") || "") || null;
  const targetPriceCents = cents(formData.get("targetPrice")) ?? opportunity.suggestedPriceCents ?? 0;
  const deliveryMin = num(formData.get("deliveryMin")) ?? 7;
  const deliveryMax = num(formData.get("deliveryMax")) ?? 12;
  const claimsAllowed = String(formData.get("claimsAllowed") || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const claimsProhibited = String(formData.get("claimsProhibited") || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!primarySupplierId) throw new Error("Choose a primary supplier before approving.");
  if (claimsAllowed.length === 0) {
    throw new Error(
      "Approve at least one claim. Store Builder and Creative Studio may only assert facts on this list, so an empty list produces copy that can state nothing about the product.",
    );
  }

  const primary = (await db.select().from(suppliers).where(eq(suppliers.id, primarySupplierId)).limit(1))[0];

  const requestId = await propose(scope, {
    actionType: "product.approve_for_build",
    targetSystem: "internal",
    summary: `Approve "${opportunity.name}" for store build at ${(targetPriceCents / 100).toFixed(2)} with ${primary?.name ?? "the selected supplier"}`,
    proposedAction: {
      opportunityId,
      productName: opportunity.name,
      primarySupplier: primary?.name,
      primarySupplierId,
      backupSupplierId,
      targetPriceCents,
      deliveryEstimate: [deliveryMin, deliveryMax],
      claimsAllowed,
      claimsProhibited,
    },
    currentState: { decision: "none recorded" },
    evidence: [
      {
        label: "Opportunity score",
        detail: `${opportunity.opportunityScore}/100, recommendation: ${opportunity.recommendation}`,
      },
      {
        label: "Unit economics",
        detail: `Landed ${((opportunity.estimatedLandedCostCents ?? 0) / 100).toFixed(2)}, margin ${((opportunity.grossMarginBps ?? 0) / 100).toFixed(1)}%, break-even CAC ${((opportunity.breakEvenCacCents ?? 0) / 100).toFixed(2)}`,
      },
      {
        label: "Supplier score",
        detail: `${primary?.name ?? "unknown"} scored ${primary?.reliabilityScore ?? "n/a"}/100`,
      },
    ],
    riskLevel: "high",
    financialImpactMinCents: 0,
    financialImpactMaxCents: 0,
    rollbackPlan:
      "The decision record is superseded by approving a different product. No external system is touched by this approval; it only unlocks drafting.",
    recommendedDecision:
      "Approve only if you would defend every claim on the allowed list to a customer who asks for proof.",
  });

  await decide(scope, requestId, "approved", { note: "Approved from the supplier comparison screen." });

  const [decision] = await db
    .insert(productDecisions)
    .values({
      storeId: scope.storeId,
      opportunityId,
      primarySupplierId,
      backupSupplierId,
      targetPriceCents,
      deliveryEstimateMin: deliveryMin,
      deliveryEstimateMax: deliveryMax,
      claimsAllowed: claimsAllowed as never,
      claimsProhibited: claimsProhibited as never,
      approvedBy: scope.userId,
    })
    .returning({ id: productDecisions.id });

  await db.update(suppliers).set({ isPrimary: false, isBackup: false }).where(eq(suppliers.opportunityId, opportunityId));
  await db.update(suppliers).set({ isPrimary: true }).where(eq(suppliers.id, primarySupplierId));
  if (backupSupplierId) {
    await db.update(suppliers).set({ isBackup: true }).where(eq(suppliers.id, backupSupplierId));
  }

  const [build] = await db
    .insert(storeBuilds)
    .values({ storeId: scope.storeId, decisionId: decision!.id, status: "drafting" })
    .returning({ id: storeBuilds.id });

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "product.approved_for_build",
    targetTable: "product_decisions",
    targetId: decision!.id,
    afterState: { opportunityId, targetPriceCents, claimsAllowed: claimsAllowed.length },
  });

  redirect(`/store-builder/${build!.id}`);
}
