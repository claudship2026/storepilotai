"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  costRecords,
  adSpendRecords,
  trafficRecords,
  customerSignals,
  recommendations,
} from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { syncFromShopify, rebuildDailyMetrics } from "@/lib/metrics";
import { runAnalyst } from "@/lib/agents/analyst";
import { runDetection } from "@/lib/detect";
import { propose } from "@/lib/approvals";
import { redactPii } from "@/lib/ai/redact";
import { audit } from "@/lib/audit";

const cents = (v: FormDataEntryValue | null) => Math.round(Number(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100);

export async function syncNow() {
  const scope = await requireScope();
  await syncFromShopify(scope, 60);
  await rebuildDailyMetrics(scope, 60);
  await runDetection(scope, 14);
  revalidatePath("/command-center");
}

export async function runAnalystAction() {
  const scope = await requireScope();
  await runAnalyst(scope, 14);
  revalidatePath("/command-center");
}

export async function addCost(formData: FormData) {
  const scope = await requireScope();
  const costType = String(formData.get("costType")) as
    | "supplier_unit"
    | "inbound_shipping"
    | "packaging"
    | "transaction_fee_rate"
    | "transaction_fee_fixed"
    | "operating_monthly";
  const sku = String(formData.get("sku") || "").trim();

  await db.insert(costRecords).values({
    storeId: scope.storeId,
    costType,
    scopeType: sku ? "sku" : "global",
    scopeValue: sku || null,
    amountCents: costType === "transaction_fee_rate" ? null : cents(formData.get("amount")),
    rateBps: costType === "transaction_fee_rate" ? Math.round(Number(formData.get("amount") || 0) * 100) : null,
    provenance: String(formData.get("provenance") || "estimated") as "verified" | "estimated",
    sourceNote: String(formData.get("sourceNote") || "") || null,
    enteredBy: scope.userId,
  });

  // Cost records are append-only and effective-dated, so historical margin is
  // never rewritten by a new entry. Rebuilding recomputes forward only.
  await rebuildDailyMetrics(scope, 60);
  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "cost.recorded",
    metadata: { costType, sku: sku || "global" },
  });
  revalidatePath("/command-center");
}

export async function addAdSpend(formData: FormData) {
  const scope = await requireScope();
  await db
    .insert(adSpendRecords)
    .values({
      storeId: scope.storeId,
      channel: String(formData.get("channel") || "meta") as "meta" | "tiktok" | "google" | "other",
      campaignRef: String(formData.get("campaignRef") || "") || null,
      spendCents: cents(formData.get("spend")),
      clicks: formData.get("clicks") ? Number(formData.get("clicks")) : null,
      impressions: formData.get("impressions") ? Number(formData.get("impressions")) : null,
      spendDate: String(formData.get("spendDate")),
      enteredBy: scope.userId,
    })
    .onConflictDoUpdate({
      target: [adSpendRecords.storeId, adSpendRecords.channel, adSpendRecords.campaignRef, adSpendRecords.spendDate],
      set: { spendCents: cents(formData.get("spend")) },
    });
  await rebuildDailyMetrics(scope, 60);
  revalidatePath("/command-center");
}

export async function addTraffic(formData: FormData) {
  const scope = await requireScope();
  await db
    .insert(trafficRecords)
    .values({
      storeId: scope.storeId,
      recordDate: String(formData.get("recordDate")),
      sessions: Number(formData.get("sessions") || 0),
      enteredBy: scope.userId,
    })
    .onConflictDoUpdate({
      target: [trafficRecords.storeId, trafficRecords.recordDate],
      set: { sessions: Number(formData.get("sessions") || 0) },
    });
  await rebuildDailyMetrics(scope, 60);
  revalidatePath("/command-center");
}

export async function addCustomerSignal(formData: FormData) {
  const scope = await requireScope();
  const raw = String(formData.get("detail") || "");
  // Redacted on the way in. Raw customer text never lands in the database and
  // therefore can never reach a prompt.
  const { text } = redactPii(raw);

  await db.insert(customerSignals).values({
    storeId: scope.storeId,
    kind: String(formData.get("kind") || "complaint"),
    theme: String(formData.get("theme") || "unspecified"),
    detail: text.slice(0, 4000),
    sentiment: formData.get("sentiment") ? String(formData.get("sentiment")) : null,
    orderRef: String(formData.get("orderRef") || "") || null,
  });
  revalidatePath("/command-center");
}

/** Turns a recommendation into an approval request carrying its exact payload. */
export async function queueRecommendation(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("recommendationId"));

  const [rec] = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.id, id), eq(recommendations.storeId, scope.storeId)))
    .limit(1);
  if (!rec) throw new Error("Recommendation not found.");

  const action = rec.proposedAction as { kind: string; payload: Record<string, unknown>; humanSummary: string } | null;

  const map: Record<string, string> = {
    shopify_update_product_description: "shopify.update_product",
    shopify_create_page: "shopify.create_page",
    shopify_create_discount: "shopify.create_discount_draft",
    shopify_update_product_seo: "shopify.set_seo",
    internal_note: "recommendation.accept",
    manual_task: "recommendation.accept",
  };

  const actionType = action ? (map[action.kind] ?? "recommendation.accept") : "recommendation.accept";
  const payload =
    actionType === "recommendation.accept"
      ? { recommendationId: id }
      : { storeId: scope.storeId, ...(action?.payload ?? {}) };

  const requestId = await propose(scope, {
    actionType,
    targetSystem: actionType.startsWith("shopify.") ? "shopify" : "internal",
    summary: action?.humanSummary ?? rec.title,
    proposedAction: payload,
    currentState: { note: "Recommendation not yet acted on." },
    evidence: (rec.evidence as Array<{ label: string; detail: string }>) ?? [],
    confidence: rec.confidence ? Number(rec.confidence) : undefined,
    riskLevel: rec.riskLevel,
    financialImpactMinCents: rec.financialImpactMinCents ?? undefined,
    financialImpactMaxCents: rec.financialImpactMaxCents ?? undefined,
    rollbackPlan: rec.rollbackPlan ?? "No external change; the recommendation is simply marked accepted.",
    recommendedDecision: rec.body.slice(0, 400),
    alternatives: (rec.missingData as string[]).map((m) => ({
      label: "Missing data",
      detail: m,
    })),
  });

  await db
    .update(recommendations)
    .set({ status: "queued_for_approval", approvalRequestId: requestId })
    .where(eq(recommendations.id, id));

  revalidatePath("/command-center");
  revalidatePath("/approvals");
}

export async function dismissRecommendation(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("recommendationId"));
  await db
    .update(recommendations)
    .set({ status: "dismissed" })
    .where(and(eq(recommendations.id, id), eq(recommendations.storeId, scope.storeId)));
  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "recommendation.dismissed",
    targetTable: "recommendations",
    targetId: id,
  });
  revalidatePath("/command-center");
}
