"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { researchProjects, evidenceItems, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { runResearch } from "@/lib/agents/research";
import { audit } from "@/lib/audit";

const dollarsToCents = (v: FormDataEntryValue | null, fallback = 0) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : fallback;
};

export async function createProject(formData: FormData) {
  const scope = await requireScope();
  const defaults = await getSetting(scope, "business_defaults");

  const [row] = await db
    .insert(researchProjects)
    .values({
      storeId: scope.storeId,
      name: String(formData.get("name") || "Untitled research"),
      niche: String(formData.get("niche") || defaults.niche),
      targetCountry: String(formData.get("targetCountry") || defaults.targetCountry),
      targetPriceCents: dollarsToCents(formData.get("targetPrice"), defaults.targetPriceCents),
      maxLandedCostCents: dollarsToCents(formData.get("maxLandedCost"), defaults.maxLandedCostCents),
      minGrossMarginBps: Math.round(Number(formData.get("minGrossMargin") || defaults.minGrossMarginBps / 100) * 100),
      maxShippingDays: Number(formData.get("maxShippingDays") || defaults.maxShippingDays),
      customerType: String(formData.get("customerType") || defaults.customerType),
      avoidCategories: String(formData.get("avoidCategories") || defaults.avoidCategories.join("\n"))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean) as never,
      launchBudgetCents: dollarsToCents(formData.get("launchBudget"), defaults.launchBudgetCents),
      createdBy: scope.userId,
    })
    .returning({ id: researchProjects.id });

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "research.project_created",
    targetTable: "research_projects",
    targetId: row!.id,
  });

  redirect(`/research/${row!.id}`);
}

const evidenceInput = z.object({
  projectId: z.string().uuid(),
  kind: z.enum([
    "manual_url",
    "supplier_url",
    "csv_upload",
    "pasted_reviews",
    "pasted_competitor",
    "manual_note",
  ]),
  label: z.string().min(1).max(200),
  url: z.string().url().optional().or(z.literal("")),
  content: z.string().max(60000).optional(),
});

export async function addEvidence(formData: FormData) {
  const scope = await requireScope();
  const parsed = evidenceInput.parse({
    projectId: formData.get("projectId"),
    kind: formData.get("kind"),
    label: formData.get("label"),
    url: (formData.get("url") as string) || "",
    content: (formData.get("content") as string) || "",
  });

  await db.insert(evidenceItems).values({
    storeId: scope.storeId,
    projectId: parsed.projectId,
    kind: parsed.kind,
    label: parsed.label,
    url: parsed.url || null,
    content: parsed.content || null,
  });

  revalidatePath(`/research/${parsed.projectId}`);
}

export async function uploadCsv(formData: FormData) {
  const scope = await requireScope();
  const projectId = String(formData.get("projectId"));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file first.");
  if (file.size > 2_000_000) throw new Error("CSV is over 2MB. Trim it to the rows that matter.");

  const text = await file.text();
  await db.insert(evidenceItems).values({
    storeId: scope.storeId,
    projectId,
    kind: "csv_upload",
    label: file.name,
    content: text.slice(0, 60000),
  });
  revalidatePath(`/research/${projectId}`);
}

export async function deleteEvidence(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("id"));
  const projectId = String(formData.get("projectId"));
  await db
    .delete(evidenceItems)
    .where(and(eq(evidenceItems.id, id), eq(evidenceItems.storeId, scope.storeId)));
  revalidatePath(`/research/${projectId}`);
}

export async function runResearchAction(formData: FormData) {
  const scope = await requireScope();
  const projectId = String(formData.get("projectId"));
  await runResearch(scope, projectId);
  revalidatePath(`/research/${projectId}`);
}

export async function selectOpportunity(formData: FormData) {
  const scope = await requireScope();
  const id = String(formData.get("opportunityId"));

  const [row] = await db
    .select()
    .from(productOpportunities)
    .where(and(eq(productOpportunities.id, id), eq(productOpportunities.storeId, scope.storeId)))
    .limit(1);
  if (!row) throw new Error("Opportunity not found.");

  await db.update(productOpportunities).set({ isSelected: true }).where(eq(productOpportunities.id, id));
  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "research.opportunity_selected",
    targetTable: "product_opportunities",
    targetId: id,
    afterState: { name: row.name, score: row.opportunityScore },
  });

  redirect(`/suppliers/${id}`);
}
