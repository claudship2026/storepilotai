import { z } from "zod";

/* Pure config definitions. No database or server-only imports, so scripts and
   tests can read them without booting the app. */

export const SETTINGS_SCHEMA = {
  kill_switch: z.object({
    enabled: z.boolean(),
    reason: z.string().default(""),
    engagedAt: z.string().nullable().default(null),
  }),
  business_defaults: z.object({
    targetCountry: z.string(),
    niche: z.string(),
    customerType: z.string(),
    targetPriceCents: z.number().int(),
    maxLandedCostCents: z.number().int(),
    minGrossMarginBps: z.number().int(),
    maxShippingDays: z.number().int(),
    launchBudgetCents: z.number().int(),
    dailyAdBudgetCents: z.number().int(),
    avoidCategories: z.array(z.string()),
  }),
  supplier_weights: z.object({
    quality: z.number(),
    shipping: z.number(),
    cost: z.number(),
    tracking: z.number(),
    inventory: z.number(),
    communication: z.number(),
    branding: z.number(),
    integration: z.number(),
  }),
  feature_flags: z.object({
    research: z.boolean(),
    suppliers: z.boolean(),
    storeBuilder: z.boolean(),
    creativeStudio: z.boolean(),
    commandCenter: z.boolean(),
    shopifyWrites: z.boolean(),
  }),
  ai_budget: z.object({
    monthlyUsd: z.number(),
    alertAtPercent: z.number(),
  }),
  /** Set on first run when ADMIN_PASSWORD_HASH is not supplied. Bcrypt hash only. */
  admin_credential: z.object({
    hash: z.string(),
    setAt: z.string().nullable().default(null),
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_SCHEMA)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  kill_switch: { enabled: false, reason: "", engagedAt: null },
  business_defaults: {
    targetCountry: "US",
    // Assumption from onboarding: US high-ticket. Editable here, nowhere else.
    niche: "High-ticket home, wellness and outdoor equipment ($249-$599)",
    customerType: "US homeowners, 30-60, disposable income, researches before buying",
    targetPriceCents: 34900,
    maxLandedCostCents: 11000,
    minGrossMarginBps: 6500,
    maxShippingDays: 12,
    launchBudgetCents: 250000,
    dailyAdBudgetCents: 7000,
    avoidCategories: [
      "ingestibles and supplements",
      "medical devices",
      "electrical items requiring safety certification",
      "baby and child safety products",
      "vape and tobacco",
      "weapons and replicas",
      "branded or trademarked lookalikes",
    ],
  },
  supplier_weights: {
    quality: 25,
    shipping: 20,
    cost: 20,
    tracking: 10,
    inventory: 10,
    communication: 5,
    branding: 5,
    integration: 5,
  },
  feature_flags: {
    research: false,
    suppliers: false,
    storeBuilder: false,
    creativeStudio: false,
    commandCenter: false,
    shopifyWrites: false,
  },
  ai_budget: { monthlyUsd: 50, alertAtPercent: 80 },
  admin_credential: { hash: "", setAt: null },
};

