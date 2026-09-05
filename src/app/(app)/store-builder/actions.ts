"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeBuilds, storeDrafts, productDecisions, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { generateDrafts, DRAFT_SPECS } from "@/lib/agents/store-builder";
import { renderDraftHtml, pushTargetFor } from "@/lib/render-draft";
import { propose } from "@/lib/approvals";
import { shopifyConfigured } from "@/lib/shopify";
import { audit } from "@/lib/audit";

export async function setBrandName(formData: FormData) {
  const scope = await requireScope();
  const buildId = String(formData.get("buildId"));
  const brandName = String(formData.get("brandName") || "").trim();
  await db
    .update(storeBuilds)
    .set({ brandName: brandName || null })
    .where(and(eq(storeBuilds.id, buildId), eq(storeBuilds.storeId, scope.storeId)));
  revalidatePath(`/store-builder/${buildId}`);
}

export async function generateDraftsAction(formData: FormData) {
  const scope = await requireScope();
  const buildId = String(formData.get("buildId"));
  const selected = formData.getAll("kinds").map(String);
  const kinds = (selected.length > 0 ? selected : DRAFT_SPECS.map((s) => s.kind)) as Parameters<
    typeof generateDrafts
  >[2];
  await generateDrafts(scope, buildId, kinds);
  revalidatePath(`/store-builder/${buildId}`);
}

export async function setDraftStatus(formData: FormData) {
  const scope = await requireScope();
  const draftId = String(formData.get("draftId"));
  const buildId = String(formData.get("buildId"));
  const status = String(formData.get("status")) as "approved" | "rejected";

  await db
    .update(storeDrafts)
    .set({ status })
    .where(and(eq(storeDrafts.id, draftId), eq(storeDrafts.storeId, scope.storeId)));

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: `store_draft.${status}`,
    targetTable: "store_drafts",
    targetId: draftId,
  });
  revalidatePath(`/store-builder/${buildId}`);
}

/**
 * Builds the exact Shopify payload for a draft and puts it in the approval
 * queue. This function performs no network call: it only proposes.
 */
export async function proposeShopifyPush(formData: FormData) {
  const scope = await requireScope();
  const draftId = String(formData.get("draftId"));
  const buildId = String(formData.get("buildId"));

  const [draft] = await db
    .select()
    .from(storeDrafts)
    .where(and(eq(storeDrafts.id, draftId), eq(storeDrafts.storeId, scope.storeId)))
    .limit(1);
  if (!draft) throw new Error("Draft not found.");

  const findings = (draft.complianceFindings as Array<{ severity: string; match: string }>) ?? [];
  const blocking = findings.filter((f) => f.severity === "block");
  if (blocking.length > 0) {
    throw new Error(
      `This draft has ${blocking.length} blocking compliance finding(s): ${blocking
        .map((f) => f.match)
        .join(", ")}. Regenerate or edit it before pushing.`,
    );
  }
  if (!shopifyConfigured()) {
    throw new Error("Shopify is not connected. Add the store domain, access token and API secret to .env.");
  }

  const [build] = await db.select().from(storeBuilds).where(eq(storeBuilds.id, buildId)).limit(1);
  const [decision] = await db
    .select()
    .from(productDecisions)
    .where(eq(productDecisions.id, build!.decisionId))
    .limit(1);
  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(eq(productOpportunities.id, decision!.opportunityId))
    .limit(1);

  const html = renderDraftHtml(draft.kind, draft.content as Record<string, unknown>);
  const target = pushTargetFor(draft.kind);
  if (!target) throw new Error("This draft kind is a working document and is not written to Shopify.");

  let actionType: string;
  let payload: Record<string, unknown>;
  let summary: string;
  let rollback: string;

  if (target === "product") {
    actionType = "shopify.create_product_draft";
    payload = {
      storeId: scope.storeId,
      draftId,
      title: `${build?.brandName ? `${build.brandName} ` : ""}${opportunity?.name ?? "Product"}`,
      bodyHtml: html,
      priceCents: decision!.targetPriceCents,
      productType: "General",
      tags: "storepilot",
    };
    summary = `Create a DRAFT product in Shopify: ${payload.title as string}`;
    rollback = "Delete the draft product in Shopify Admin. It is created unpublished, so no customer can see it.";
  } else if (target === "seo") {
    const productDraft = (
      await db
        .select()
        .from(storeDrafts)
        .where(and(eq(storeDrafts.buildId, buildId), eq(storeDrafts.kind, "product_page")))
        .limit(1)
    )[0];
    if (!productDraft?.shopifyResourceId) {
      throw new Error("Push the product page first: SEO metafields attach to a product that must already exist.");
    }
    const entries = (draft.content as { entries: Array<{ page: string; title: string; description: string }> }).entries;
    const productEntry = entries.find((e) => /product/i.test(e.page)) ?? entries[0]!;
    actionType = "shopify.set_seo";
    payload = {
      storeId: scope.storeId,
      ownerType: "product",
      ownerId: productDraft.shopifyResourceId,
      title: productEntry.title,
      description: productEntry.description,
    };
    summary = `Set SEO title and description on the product`;
    rollback = "Clear the global.title_tag and global.description_tag metafields on that product.";
  } else {
    actionType = "shopify.create_page";
    payload = {
      storeId: scope.storeId,
      draftId,
      title: draft.title,
      bodyHtml: html,
      handle: draft.kind.replace(/_/g, "-"),
    };
    summary = `Create an UNPUBLISHED page in Shopify: ${draft.title}`;
    rollback = "Delete the page in Shopify Admin. It is created unpublished, so no customer can see it.";
  }

  await propose(scope, {
    actionType,
    targetSystem: "shopify",
    summary,
    proposedAction: payload,
    currentState: { note: "This resource does not exist in Shopify yet." },
    evidence: [
      { label: "Draft", detail: `${draft.title} (${draft.kind}), version ${draft.version}` },
      {
        label: "Claims used",
        detail: (draft.claimsUsed as string[]).join("; ") || "none asserted",
      },
      {
        label: "Compliance findings",
        detail: findings.length === 0 ? "clean" : findings.map((f) => f.match).join("; "),
      },
    ],
    riskLevel: target === "product" ? "high" : "medium",
    financialImpactMinCents: 0,
    financialImpactMaxCents: 0,
    rollbackPlan: rollback,
    recommendedDecision: "Read the rendered HTML in the diff. It is exactly what will be sent.",
  });

  revalidatePath(`/store-builder/${buildId}`);
  revalidatePath("/approvals");
}

export async function proposeWebhookRegistration() {
  const scope = await requireScope();
  if (!shopifyConfigured()) throw new Error("Connect Shopify first.");

  await propose(scope, {
    actionType: "shopify.register_webhooks",
    targetSystem: "shopify",
    summary: "Register the 15 Shopify webhook topics the Command Center needs",
    proposedAction: { storeId: scope.storeId },
    currentState: { note: "Registration is checked and only missing topics are created." },
    evidence: [
      {
        label: "Topics",
        detail:
          "orders create/paid/updated/cancelled/fulfilled/partially_fulfilled, fulfillments create/update, refunds/create, products create/update/delete, inventory_levels/update, app/uninstalled, shop/update",
      },
    ],
    riskLevel: "low",
    rollbackPlan: "Delete the webhook subscriptions in Shopify Admin under Settings → Notifications → Webhooks.",
    recommendedDecision: "Approve once your app URL is publicly reachable, otherwise Shopify cannot deliver.",
  });
  revalidatePath("/approvals");
}
