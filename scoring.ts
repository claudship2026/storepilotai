/**
 * Deterministic arithmetic. No model is involved in anything here, and none
 * should be: a language model that computes a margin will occasionally compute
 * it wrong and be confident about it.
 *
 * The agents supply estimates and judgement. This file turns those into money.
 */

export type Weights = {
  quality: number;
  shipping: number;
  cost: number;
  tracking: number;
  inventory: number;
  communication: number;
  branding: number;
  integration: number;
};

export type UnitEconomics = {
  sellingPriceCents: number;
  productCostCents: number;
  shippingCostCents: number;
  landedCostCents: number;
  paymentFeeCents: number;
  grossProfitCents: number;
  grossMarginBps: number;
  /** The most you can pay to acquire a customer and still break even. */
  breakEvenCacCents: number;
  /** Orders per day needed for the daily ad budget to break even. */
  breakEvenOrdersPerDay: number;
  meetsMarginFloor: boolean;
};

const PAYMENT_RATE_BPS = 290; // Shopify Payments US card-present-absent default
const PAYMENT_FIXED_CENTS = 30;

export function unitEconomics(input: {
  sellingPriceCents: number;
  productCostCents: number;
  shippingCostCents: number;
  minGrossMarginBps: number;
  dailyAdBudgetCents?: number;
  paymentRateBps?: number;
  paymentFixedCents?: number;
}): UnitEconomics {
  const rate = input.paymentRateBps ?? PAYMENT_RATE_BPS;
  const fixed = input.paymentFixedCents ?? PAYMENT_FIXED_CENTS;

  const landed = input.productCostCents + input.shippingCostCents;
  const fee = Math.round((input.sellingPriceCents * rate) / 10000) + fixed;
  const gross = input.sellingPriceCents - landed - fee;
  const marginBps =
    input.sellingPriceCents > 0 ? Math.round((gross / input.sellingPriceCents) * 10000) : 0;

  const dailyBudget = input.dailyAdBudgetCents ?? 0;
  return {
    sellingPriceCents: input.sellingPriceCents,
    productCostCents: input.productCostCents,
    shippingCostCents: input.shippingCostCents,
    landedCostCents: landed,
    paymentFeeCents: fee,
    grossProfitCents: gross,
    grossMarginBps: marginBps,
    // Break-even CAC is exactly the gross profit: spend more than this to get a
    // customer and the order loses money before a single refund.
    breakEvenCacCents: Math.max(0, gross),
    breakEvenOrdersPerDay: gross > 0 ? Number((dailyBudget / gross).toFixed(2)) : Infinity,
    meetsMarginFloor: marginBps >= input.minGrossMarginBps,
  };
}

/* ------------------------------------------------------------------ */
/* Supplier scoring                                                    */
/* ------------------------------------------------------------------ */

export type SupplierInputs = {
  rating: number | null; // 0-5
  reviewCount: number | null;
  deliveryDaysMax: number | null;
  processingDays: number | null;
  landedCostCents: number | null;
  targetLandedCostCents: number;
  trackingAvailable: boolean | null;
  inventoryStatus: string | null;
  communicationNote: string | null;
  brandingAvailable: boolean | null;
  integrationAvailable: string | null;
  maxShippingDays: number;
};

export type SupplierScore = {
  total: number;
  components: Record<keyof Weights, { score: number; weight: number; contribution: number; note: string }>;
  /** Criteria with no data at all. A high score built on three known fields is not a high score. */
  missingCriteria: string[];
  confidence: number;
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function scoreSupplier(input: SupplierInputs, weights: Weights): SupplierScore {
  const missing: string[] = [];

  // Quality: rating scaled from 3.0-5.0, dampened when the review count is thin.
  let quality = 0.5;
  let qualityNote = "no rating supplied";
  if (input.rating != null) {
    const base = clamp01((input.rating - 3) / 2);
    const volumeTrust = clamp01(Math.log10((input.reviewCount ?? 1) + 1) / 3);
    quality = base * (0.55 + 0.45 * volumeTrust);
    qualityNote = `${input.rating.toFixed(1)}/5 across ${input.reviewCount ?? "unknown"} reviews`;
  } else missing.push("quality");

  // Shipping: full marks well inside the promise, zero at or past it.
  let shipping = 0.4;
  let shippingNote = "no delivery estimate supplied";
  if (input.deliveryDaysMax != null) {
    const total = input.deliveryDaysMax + (input.processingDays ?? 0);
    shipping = clamp01((input.maxShippingDays - total) / Math.max(1, input.maxShippingDays * 0.6));
    shippingNote = `${total} days door to door against a ${input.maxShippingDays}-day promise`;
  } else missing.push("shipping");

  // Cost: full marks at 70% of the target landed cost, zero at 130%.
  let cost = 0.4;
  let costNote = "no landed cost supplied";
  if (input.landedCostCents != null && input.targetLandedCostCents > 0) {
    const ratio = input.landedCostCents / input.targetLandedCostCents;
    cost = clamp01((1.3 - ratio) / 0.6);
    costNote = `${(ratio * 100).toFixed(0)}% of target landed cost`;
  } else missing.push("cost");

  const tracking = input.trackingAvailable == null ? 0.3 : input.trackingAvailable ? 1 : 0;
  if (input.trackingAvailable == null) missing.push("tracking");

  const inv = (input.inventoryStatus ?? "").toLowerCase();
  const inventory = inv.includes("in stock")
    ? 1
    : inv.includes("low")
      ? 0.45
      : inv.includes("out")
        ? 0
        : (missing.push("inventory"), 0.35);

  const comm = (input.communicationNote ?? "").toLowerCase();
  const communication = comm
    ? comm.includes("fast") || comm.includes("responsive") || comm.includes("same day")
      ? 1
      : comm.includes("slow") || comm.includes("no reply") || comm.includes("unresponsive")
        ? 0.1
        : 0.6
    : (missing.push("communication"), 0.4);

  const branding = input.brandingAvailable == null ? (missing.push("branding"), 0.3) : input.brandingAvailable ? 1 : 0.15;

  const integ = (input.integrationAvailable ?? "").toLowerCase();
  const integration = integ
    ? integ.includes("api") || integ.includes("dsers") || integ.includes("cj") || integ.includes("zendrop")
      ? 1
      : integ.includes("csv")
        ? 0.5
        : 0.3
    : (missing.push("integration"), 0.3);

  const raw: Record<keyof Weights, { score: number; note: string }> = {
    quality: { score: quality, note: qualityNote },
    shipping: { score: shipping, note: shippingNote },
    cost: { score: cost, note: costNote },
    tracking: { score: tracking, note: input.trackingAvailable ? "tracking provided" : "no tracking" },
    inventory: { score: inventory, note: input.inventoryStatus ?? "unknown" },
    communication: { score: communication, note: input.communicationNote ?? "unknown" },
    branding: { score: branding, note: input.brandingAvailable ? "private label available" : "generic packaging" },
    integration: { score: integration, note: input.integrationAvailable ?? "unknown" },
  };

  const components = {} as SupplierScore["components"];
  let total = 0;
  for (const key of Object.keys(raw) as Array<keyof Weights>) {
    const weight = weights[key];
    const contribution = raw[key].score * weight;
    total += contribution;
    components[key] = {
      score: Number((raw[key].score * 100).toFixed(0)),
      weight,
      contribution: Number(contribution.toFixed(1)),
      note: raw[key].note,
    };
  }

  return {
    total: Math.round(total),
    components,
    missingCriteria: missing,
    confidence: Number((1 - missing.length / 8).toFixed(2)),
  };
}

/* ------------------------------------------------------------------ */
/* Opportunity score                                                   */
/* ------------------------------------------------------------------ */

export type OpportunityInputs = {
  economics: UnitEconomics;
  /** 0-100 judgements supplied by the research agent, each evidence-backed. */
  demandSignal: number;
  differentiation: number;
  contentPotential: number;
  supplierAvailability: number;
  saturationRisk: number;
  complianceRisk: number;
  returnRisk: number;
  shippingRisk: number;
  evidenceQuality: number;
  shippingDaysEstimate: number | null;
  maxShippingDays: number;
};

/**
 * Half the score is money, which we compute ourselves; half is judgement, which
 * the agent supplies with evidence. The result is then capped by evidence
 * quality, so a thinly-sourced candidate cannot outrank a well-sourced one on
 * enthusiasm alone.
 */
export function scoreOpportunity(i: OpportunityInputs): { score: number; breakdown: Record<string, number> } {
  const marginPoints = clamp01((i.economics.grossMarginBps - 4000) / 3500) * 22;
  const cacPoints = clamp01(i.economics.breakEvenCacCents / 20000) * 10;
  const floorPenalty = i.economics.meetsMarginFloor ? 0 : -15;

  const shippingPoints =
    i.shippingDaysEstimate == null
      ? 3
      : clamp01((i.maxShippingDays - i.shippingDaysEstimate) / Math.max(1, i.maxShippingDays * 0.6)) * 8;

  const demandPoints = (i.demandSignal / 100) * 16;
  const diffPoints = (i.differentiation / 100) * 12;
  const contentPoints = (i.contentPotential / 100) * 8;
  const supplyPoints = (i.supplierAvailability / 100) * 8;

  const saturationPenalty = -(i.saturationRisk / 100) * 12;
  const compliancePenalty = -(i.complianceRisk / 100) * 14;
  const returnPenalty = -(i.returnRisk / 100) * 10;
  const shippingPenalty = -(i.shippingRisk / 100) * 8;

  const breakdown = {
    margin: Number(marginPoints.toFixed(1)),
    breakEvenCac: Number(cacPoints.toFixed(1)),
    marginFloor: floorPenalty,
    shippingSpeed: Number(shippingPoints.toFixed(1)),
    demand: Number(demandPoints.toFixed(1)),
    differentiation: Number(diffPoints.toFixed(1)),
    contentPotential: Number(contentPoints.toFixed(1)),
    supplierAvailability: Number(supplyPoints.toFixed(1)),
    saturationRisk: Number(saturationPenalty.toFixed(1)),
    complianceRisk: Number(compliancePenalty.toFixed(1)),
    returnRisk: Number(returnPenalty.toFixed(1)),
    shippingRisk: Number(shippingPenalty.toFixed(1)),
  };

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0) + 30;
  // Evidence cap: thin sourcing cannot produce a high score.
  const cap = 45 + (i.evidenceQuality / 100) * 55;
  const score = Math.max(0, Math.min(Math.round(raw), Math.round(cap)));
  return { score, breakdown };
}

export function recommendationFor(score: number, economics: UnitEconomics, complianceRisk: number): "pursue" | "research_more" | "avoid" {
  if (complianceRisk >= 70) return "avoid";
  if (!economics.meetsMarginFloor) return "avoid";
  if (score >= 68) return "pursue";
  if (score >= 45) return "research_more";
  return "avoid";
}
