import { z } from "zod";

/**
 * Every structured output the system accepts from Claude. If a payload does not
 * parse here, it does not exist as far as the rest of the application is
 * concerned: it goes to human review instead of into the database.
 *
 * `provenance` appears on every estimate deliberately. It is what lets the UI
 * refuse to present a guess as a fact.
 */

export const provenanceEnum = z.enum(["verified", "supplier_provided", "estimated", "missing"]);

const scored = z
  .number()
  .min(0)
  .max(100)
  .describe("0-100 judgement. Base it on the supplied evidence, not on general impressions.");

export const evidenceRef = z.object({
  claim: z.string(),
  source: z.string().describe("URL, uploaded file name, or 'operator note'. Never invent one."),
  provenance: provenanceEnum,
});

/* ------------------------------------------------------------------ */
/* 1. Research                                                          */
/* ------------------------------------------------------------------ */

export const productOpportunitySchema = z.object({
  name: z.string(),
  summary: z.string(),
  customerProblem: z.string(),
  targetBuyer: z.string(),
  whyItMaySell: z.string(),

  competitorPriceMinCents: z.number().int().nullable(),
  competitorPriceMaxCents: z.number().int().nullable(),
  estimatedProductCostCents: z.number().int().nullable(),
  estimatedShippingCostCents: z.number().int().nullable(),
  suggestedPriceCents: z.number().int(),
  estimatedShippingDays: z.number().int().nullable(),

  bundleIdeas: z.array(z.string()).max(6),
  mainObjections: z.array(z.string()).max(6),
  qualityRisks: z.array(z.string()).max(6),
  shippingRisks: z.array(z.string()).max(6),
  complianceNotes: z.array(z.string()).max(6),

  demandSignal: scored,
  differentiation: scored,
  contentPotential: scored,
  supplierAvailability: scored,
  saturationRisk: scored,
  complianceRisk: scored,
  returnRisk: scored,
  shippingRisk: scored,
  evidenceQuality: scored.describe(
    "How well the supplied evidence actually supports these judgements. Low is the honest answer when little was supplied.",
  ),

  supplierNotes: z.string(),
  evidence: z.array(evidenceRef).max(20),
  verifiedVsEstimated: z.string().describe("Plain-English statement of what is known versus guessed."),
  reasoning: z.string(),
});

export const researchOutputSchema = z.object({
  products: z.array(productOpportunitySchema).min(1).max(8),
  notes: z.string(),
  dataGaps: z.array(z.string()).max(10),
});

export type ResearchOutput = z.infer<typeof researchOutputSchema>;
export type ProductOpportunityAnalysis = z.infer<typeof productOpportunitySchema>;

/* ------------------------------------------------------------------ */
/* 2. Supplier review                                                   */
/* ------------------------------------------------------------------ */

export const supplierReviewSchema = z.object({
  perSupplier: z.array(
    z.object({
      supplierName: z.string(),
      strengths: z.array(z.string()).max(5),
      weaknesses: z.array(z.string()).max(5),
      defectRiskNote: z.string(),
      qualitySignals: z.string(),
      missingInformation: z.array(z.string()).max(8),
      questionsToAsk: z.array(z.string()).max(6),
    }),
  ),
  primaryRecommendation: z.string(),
  backupRecommendation: z.string(),
  reasoning: z.string(),
  claimsSupportable: z.array(z.string()).max(15).describe("Claims the supplied evidence would actually support."),
  claimsToAvoid: z.array(z.string()).max(15),
});

export type SupplierReview = z.infer<typeof supplierReviewSchema>;

/* ------------------------------------------------------------------ */
/* 3. Store builder                                                     */
/* ------------------------------------------------------------------ */

export const brandIdentitySchema = z.object({
  nameIdeas: z.array(z.object({ name: z.string(), rationale: z.string(), domainNote: z.string() })).min(5).max(10),
  positioning: z.string(),
  voice: z.object({
    description: z.string(),
    doList: z.array(z.string()).max(6),
    dontList: z.array(z.string()).max(6),
  }),
  palette: z.array(z.object({ role: z.string(), hex: z.string(), use: z.string() })).min(4).max(8),
  typography: z.object({ headings: z.string(), body: z.string(), rationale: z.string() }),
  logoPrompts: z.array(z.string()).max(6),
  imagePrompts: z.array(z.string()).max(8),
});

export const sectionSchema = z.object({
  heading: z.string(),
  subheading: z.string().nullable(),
  body: z.string(),
  bullets: z.array(z.string()).max(8),
  cta: z.string().nullable(),
  layoutNote: z.string(),
});

export const homepageSchema = z.object({
  sections: z.array(sectionSchema).min(4).max(12),
  mobileOrder: z.array(z.string()),
  claimsUsed: z.array(z.string()).max(20),
});

export const productPageSchema = z.object({
  headline: z.string(),
  valueProposition: z.string(),
  offer: z.object({
    primary: z.string(),
    bundles: z.array(z.object({ name: z.string(), contents: z.string(), priceLogic: z.string() })).max(4),
  }),
  benefits: z.array(z.object({ benefit: z.string(), backedBy: z.string() })).max(8),
  mediaPlan: z.array(z.object({ position: z.string(), asset: z.string(), purpose: z.string() })).max(10),
  socialProofPlan: z.string().describe("How the area works before real reviews exist. Never invent reviews."),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).min(5).max(12),
  shippingExpectation: z.string(),
  returnsExplanation: z.string(),
  comparison: z
    .object({ includeIt: z.boolean(), reason: z.string(), rows: z.array(z.object({ attribute: z.string(), us: z.string(), them: z.string() })).max(8) })
    .describe("Only include if factually supportable from approved claims."),
  objectionHandling: z.array(z.object({ objection: z.string(), response: z.string() })).max(8),
  stickyAddToCart: z.string(),
  frequentlyBoughtTogether: z.string(),
  postPurchaseUpsell: z.string(),
  mobileLayout: z.array(z.string()).max(14),
  claimsUsed: z.array(z.string()).max(25),
});

export const policySchema = z.object({
  title: z.string(),
  bodyHtml: z.string(),
  plainSummary: z.string(),
  operatorChecklist: z.array(z.string()).max(8).describe("What must be true operationally for this policy to be honest."),
});

export const seoSchema = z.object({
  entries: z
    .array(z.object({ page: z.string(), title: z.string().max(70), description: z.string().max(165), keywords: z.array(z.string()).max(8) }))
    .min(4)
    .max(14),
});

export const listSchema = z.object({
  items: z.array(z.object({ title: z.string(), detail: z.string() })).min(4).max(30),
});

export const genericContentSchema = z.object({
  title: z.string(),
  sections: z.array(sectionSchema).max(10),
  claimsUsed: z.array(z.string()).max(20),
});

/* ------------------------------------------------------------------ */
/* 4. Creative                                                          */
/* ------------------------------------------------------------------ */

export const adConceptSchema = z.object({
  title: z.string(),
  targetCustomer: z.string(),
  platform: z.string(),
  funnelStage: z.enum(["cold", "warm", "retargeting", "retention"]),
  hook: z.string(),
  coreMessage: z.string(),
  offer: z.string(),
  cta: z.string(),
  script: z.string(),
  visualInstructions: z.string(),
  textOverlays: z.array(z.string()).max(8),
  creatorInstructions: z.string(),
  claimsUsed: z.array(z.string()).max(10),
  complianceWarning: z.string(),
  testMetric: z.string(),
  suggestedTestBudgetCents: z.number().int(),
});

export const creativeBatchSchema = z.object({
  concepts: z.array(adConceptSchema).min(1).max(20),
});

export const shortItemsSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string(),
        angle: z.string(),
        claimsUsed: z.array(z.string()).max(6),
      }),
    )
    .min(3)
    .max(20),
});

export const emailSequenceSchema = z.object({
  sequenceName: z.string(),
  emails: z
    .array(
      z.object({
        step: z.number().int(),
        delay: z.string(),
        subject: z.string(),
        preheader: z.string(),
        body: z.string(),
        cta: z.string(),
        claimsUsed: z.array(z.string()).max(8),
      }),
    )
    .min(3)
    .max(8),
});

export const promptPackSchema = z.object({
  imagePrompts: z.array(z.object({ purpose: z.string(), prompt: z.string() })).min(3).max(12),
  storyboardPrompts: z.array(z.object({ concept: z.string(), prompt: z.string() })).min(3).max(10),
});

/* ------------------------------------------------------------------ */
/* 5. Command Center analyst                                            */
/* ------------------------------------------------------------------ */

export const analystOutputSchema = z.object({
  recommendations: z
    .array(
      z.object({
        category: z.enum([
          "conversion",
          "profit",
          "product",
          "supplier",
          "support",
          "content",
          "ads",
          "offer",
          "data",
        ]),
        title: z.string(),
        body: z.string(),
        evidence: z.array(z.object({ label: z.string(), detail: z.string() })).min(1).max(6),
        financialImpactMinCents: z.number().int().nullable(),
        financialImpactMaxCents: z.number().int().nullable(),
        confidence: z.number().min(0).max(1),
        riskLevel: z.enum(["low", "medium", "high", "critical"]),
        proposedAction: z
          .object({
            kind: z.enum([
              "shopify_update_product_description",
              "shopify_create_page",
              "shopify_create_discount",
              "shopify_update_product_seo",
              "internal_note",
              "manual_task",
            ]),
            payload: z.record(z.string(), z.unknown()),
            humanSummary: z.string(),
          })
          .nullable(),
        requiresApproval: z.boolean(),
        rollbackPlan: z.string(),
        missingData: z.array(z.string()).max(6),
      }),
    )
    .max(12),
  summary: z.string(),
});

export type AnalystOutput = z.infer<typeof analystOutputSchema>;

/* ------------------------------------------------------------------ */
/* 6. Store stack                                                       */
/* ------------------------------------------------------------------ */

export const stackOutputSchema = z.object({
  apps: z
    .array(
      z.object({
        category: z.string(),
        appName: z.string(),
        whyNeeded: z.string(),
        essentialBeforeLaunch: z.boolean(),
        freePlanAvailable: z.boolean(),
        estimatedMonthlyCents: z.number().int().nullable(),
        dataPermissions: z.array(z.string()).max(8),
        setupSteps: z.array(z.string()).max(8),
        risks: z.array(z.string()).max(6),
        alternatives: z.array(z.string()).max(4),
        installUrl: z.string().nullable(),
      }),
    )
    .max(12),
  omitted: z.array(z.object({ category: z.string(), reason: z.string() })).max(8),
  totalMonthlyEstimateCents: z.number().int(),
  notes: z.string(),
});

export type StackOutput = z.infer<typeof stackOutputSchema>;
