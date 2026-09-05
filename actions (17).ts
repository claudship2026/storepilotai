"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/session";
import { setSetting } from "@/lib/settings";
import { setKillSwitch } from "@/lib/killswitch";

const dollarsToCents = (v: FormDataEntryValue | null) =>
  Math.round(Number(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100);

export async function saveBusinessDefaults(formData: FormData) {
  const scope = await requireScope();
  const value = {
    targetCountry: String(formData.get("targetCountry") ?? "US"),
    niche: String(formData.get("niche") ?? ""),
    customerType: String(formData.get("customerType") ?? ""),
    targetPriceCents: dollarsToCents(formData.get("targetPrice")),
    maxLandedCostCents: dollarsToCents(formData.get("maxLandedCost")),
    minGrossMarginBps: Math.round(Number(formData.get("minGrossMargin") ?? 0) * 100),
    maxShippingDays: Number(formData.get("maxShippingDays") ?? 12),
    launchBudgetCents: dollarsToCents(formData.get("launchBudget")),
    dailyAdBudgetCents: dollarsToCents(formData.get("dailyAdBudget")),
    avoidCategories: String(formData.get("avoidCategories") ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  await setSetting(scope, "business_defaults", value);
  revalidatePath("/settings");
  revalidatePath("/dashboard");
}

const weightsSchema = z.object({
  quality: z.number(),
  shipping: z.number(),
  cost: z.number(),
  tracking: z.number(),
  inventory: z.number(),
  communication: z.number(),
  branding: z.number(),
  integration: z.number(),
});

export async function saveSupplierWeights(formData: FormData) {
  const scope = await requireScope();
  const raw = Object.fromEntries(
    Object.keys(weightsSchema.shape).map((k) => [k, Number(formData.get(k) ?? 0)]),
  );
  const value = weightsSchema.parse(raw);
  const total = Object.values(value).reduce((a, b) => a + b, 0);
  if (Math.round(total) !== 100) {
    throw new Error(`Supplier weights must total 100. They currently total ${total}.`);
  }
  await setSetting(scope, "supplier_weights", value);
  revalidatePath("/settings");
}

export async function saveFlags(formData: FormData) {
  const scope = await requireScope();
  const on = (k: string) => formData.get(k) === "on";
  await setSetting(scope, "feature_flags", {
    research: on("research"),
    suppliers: on("suppliers"),
    storeBuilder: on("storeBuilder"),
    creativeStudio: on("creativeStudio"),
    commandCenter: on("commandCenter"),
    shopifyWrites: on("shopifyWrites"),
  });
  revalidatePath("/settings");
}

export async function saveAiBudget(formData: FormData) {
  const scope = await requireScope();
  await setSetting(scope, "ai_budget", {
    monthlyUsd: Number(formData.get("monthlyUsd") ?? 50),
    alertAtPercent: Number(formData.get("alertAtPercent") ?? 80),
  });
  revalidatePath("/settings");
  revalidatePath("/dashboard");
}

export async function toggleKillSwitch(formData: FormData) {
  const scope = await requireScope();
  const enabled = formData.get("enabled") === "true";
  await setKillSwitch(scope, enabled, String(formData.get("reason") ?? ""));
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/approvals");
}
