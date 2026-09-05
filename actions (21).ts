"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creativeBatches, creativeAssets, productDecisions } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { generateCreative, CREATIVE_JOBS } from "@/lib/agents/creative";
import { audit } from "@/lib/audit";

export async function createBatch(formData: FormData) {
  const scope = await requireScope();
  const label = String(formData.get("label") || `Batch ${new Date().toISOString().slice(0, 10)}`);

  const [decision] = await db
    .select()
    .from(productDecisions)
    .where(eq(productDecisions.storeId, scope.storeId))
    .orderBy(desc(productDecisions.approvedAt))
    .limit(1);
  if (!decision) throw new Error("Approve a product for build first. Creative may only use approved claims.");

  const [batch] = await db
    .insert(creativeBatches)
    .values({ storeId: scope.storeId, decisionId: decision.id, label })
    .returning({ id: creativeBatches.id });

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: "creative.batch_created",
    targetTable: "creative_batches",
    targetId: batch!.id,
  });

  revalidatePath("/creative");
}

export async function generateCreativeAction(formData: FormData) {
  const scope = await requireScope();
  const batchId = String(formData.get("batchId"));
  const selected = formData.getAll("kinds").map(String);
  const kinds = (selected.length > 0
    ? selected
    : [...CREATIVE_JOBS.map((j) => j.kind), "image_prompt"]) as Parameters<typeof generateCreative>[2];
  await generateCreative(scope, batchId, kinds);
  revalidatePath("/creative");
}

export async function setAssetStatus(formData: FormData) {
  const scope = await requireScope();
  const assetId = String(formData.get("assetId"));
  const status = String(formData.get("status")) as "approved" | "rejected";

  const [asset] = await db
    .select()
    .from(creativeAssets)
    .where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.storeId, scope.storeId)))
    .limit(1);
  if (!asset) throw new Error("Asset not found.");
  if (asset.blocked && status === "approved") {
    throw new Error("This asset is blocked by the compliance scan and cannot be approved. Regenerate it.");
  }

  await db.update(creativeAssets).set({ status }).where(eq(creativeAssets.id, assetId));
  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: `creative.${status}`,
    targetTable: "creative_assets",
    targetId: assetId,
  });
  revalidatePath("/creative");
}
