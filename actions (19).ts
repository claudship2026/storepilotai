"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stackItems, productDecisions, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { recommendStack } from "@/lib/agents/analyst";
import { propose } from "@/lib/approvals";
import { money } from "@/components/ui";

export async function generateStack() {
  const scope = await requireScope();

  const [decision] = await db
    .select({
      name: productOpportunities.name,
      analysis: productOpportunities.analysis,
      priceCents: productDecisions.targetPriceCents,
      deliveryMin: productDecisions.deliveryEstimateMin,
      deliveryMax: productDecisions.deliveryEstimateMax,
    })
    .from(productDecisions)
    .innerJoin(productOpportunities, eq(productDecisions.opportunityId, productOpportunities.id))
    .where(eq(productDecisions.storeId, scope.storeId))
    .orderBy(desc(productDecisions.approvedAt))
    .limit(1);

  const a = (decision?.analysis as Record<string, unknown>) ?? {};
  const context = decision
    ? `Product: ${decision.name}
Price: $${(decision.priceCents / 100).toFixed(2)}
Delivery: ${decision.deliveryMin}-${decision.deliveryMax} days
Customer problem: ${String(a.customerProblem ?? "not recorded")}
Known objections: ${JSON.stringify(a.mainObjections ?? [])}
Repeat purchase likely: ${String(a.bundleIdeas ?? "").includes("refill") ? "possibly" : "unlikely — this is a one-time purchase"}`
    : "No product approved yet. Recommend only the stack that any single-product US store needs before launch.";

  await recommendStack(scope, context);
  revalidatePath("/stack");
}

export async function proposeAppInstall(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("stackItemId"));

  const [item] = await db
    .select()
    .from(stackItems)
    .where(and(eq(stackItems.id, id), eq(stackItems.storeId, scope.storeId)))
    .limit(1);
  if (!item) throw new Error("App not found.");

  await propose(scope, {
    actionType: "stack.approve_app",
    targetSystem: "internal",
    summary: `Approve installing ${item.appName} (${item.category})${
      item.estimatedMonthlyCents ? ` at about ${money(item.estimatedMonthlyCents)}/month` : ""
    }`,
    proposedAction: { stackItemId: id, appName: item.appName, installUrl: item.installUrl },
    currentState: { status: item.status },
    evidence: [
      { label: "Why", detail: item.whyNeeded },
      { label: "Data permissions", detail: (item.dataPermissions as string[]).join("; ") || "not stated" },
      { label: "Risks", detail: (item.risks as string[]).join("; ") },
      { label: "Alternatives", detail: (item.alternatives as string[]).join("; ") || "none listed" },
    ],
    riskLevel: (item.dataPermissions as string[]).length > 2 ? "high" : "medium",
    financialImpactMinCents: item.freePlanAvailable ? 0 : (item.estimatedMonthlyCents ?? 0),
    financialImpactMaxCents: (item.estimatedMonthlyCents ?? 0) * 12,
    rollbackPlan: `Uninstall ${item.appName} from Shopify Admin → Apps. Check for leftover theme code after uninstalling; many apps leave script tags behind.`,
    recommendedDecision:
      "Approving records the decision. Installation itself is manual and stays that way, so nothing is installed on your behalf.",
  });

  revalidatePath("/stack");
  revalidatePath("/approvals");
}
