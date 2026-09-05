import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeBuilds, storeDrafts, productDecisions, productOpportunities, suppliers } from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/claude";
import {
  brandIdentitySchema,
  homepageSchema,
  productPageSchema,
  policySchema,
  seoSchema,
  listSchema,
  genericContentSchema,
} from "@/lib/ai/schemas";
import { assertWritesAllowed } from "@/lib/killswitch";
import { scanPayload, checkClaims, isBlocked } from "@/lib/compliance";
import { audit } from "@/lib/audit";
import { log } from "@/lib/logger";
import type { Scope } from "@/lib/db/scoped";

type DraftKind =
  | "brand_identity" | "homepage" | "product_page" | "bundles" | "cart_upsells" | "comparison"
  | "benefits" | "how_it_works" | "specifications" | "faq" | "about" | "contact"
  | "shipping_policy" | "refund_policy" | "privacy_policy" | "terms" | "order_tracking_plan"
  | "seo" | "email_optin" | "trust_sections" | "mobile_structure"
  | "photo_shot_list" | "ugc_shot_list" | "launch_checklist";

type Spec = {
  kind: DraftKind;
  title: string;
  schema: z.ZodTypeAny;
  instruction: string;
  tier?: "cheap" | "frontier";
};

const SPECS: Spec[] = [
  {
    kind: "brand_identity",
    title: "Brand identity",
    schema: brandIdentitySchema,
    instruction:
      "Produce brand name ideas (each with a rationale and a note on likely domain availability, clearly marked as unverified), positioning, voice with do and don't lists, a colour palette with hex values and usage roles, typography direction, and prompts for logo and hero imagery.",
  },
  {
    kind: "homepage",
    title: "Homepage",
    schema: homepageSchema,
    instruction:
      "Write the homepage as ordered sections: hero, problem, mechanism, proof placeholder, benefits, objection handling, guarantee framed as the real return policy, and a closing CTA. Give the mobile section order separately.",
  },
  {
    kind: "product_page",
    title: "Product page",
    schema: productPageSchema,
    instruction:
      "Write the full high-converting product page. Every benefit must name what backs it in `backedBy`. The social proof area must describe how it works with zero reviews at launch. Include the comparison section only if the approved claims genuinely support it, and say so in the reason field either way.",
  },
  {
    kind: "bundles",
    title: "Bundles and offer ladder",
    schema: listSchema,
    instruction: "Design 4 to 6 bundle and offer-ladder options with the pricing logic and who each is for.",
  },
  {
    kind: "cart_upsells",
    title: "Cart and post-purchase upsells",
    schema: listSchema,
    instruction: "Design cart upsells and one post-purchase upsell, each with the reason a buyer would accept it.",
  },
  {
    kind: "comparison",
    title: "Comparison section",
    schema: genericContentSchema,
    instruction:
      "Draft a comparison section against the generic alternative, using only attributes the approved claims support. If they support nothing comparable, say so plainly and return a single section explaining why the comparison should be omitted.",
  },
  { kind: "benefits", title: "Benefits section", schema: genericContentSchema, instruction: "Draft the benefits section. Each benefit must trace to an approved claim." },
  { kind: "how_it_works", title: "How it works", schema: genericContentSchema, instruction: "Draft a three to five step 'how it works' section describing the actual mechanism." },
  { kind: "specifications", title: "Specifications", schema: listSchema, instruction: "Draft the specification list. Mark any specification you do not have as 'to be confirmed with supplier' rather than guessing a number.", tier: "cheap" },
  { kind: "faq", title: "FAQ page", schema: listSchema, instruction: "Write 12 FAQ entries covering shipping, returns, sizing or fit, materials, warranty, support, and the objections most likely to stop a purchase at this price." },
  { kind: "about", title: "About page", schema: genericContentSchema, instruction: "Write an about page that is honest about being a small new brand. Do not invent a founding story, a factory, or a team." },
  { kind: "contact", title: "Contact page", schema: genericContentSchema, instruction: "Write the contact page with response-time expectations the operator can actually meet.", tier: "cheap" },
  {
    kind: "shipping_policy",
    title: "Shipping policy",
    schema: policySchema,
    instruction:
      "Write the shipping policy using the approved delivery estimate exactly. Include the operator checklist of what must be true for this policy to be honest.",
  },
  { kind: "refund_policy", title: "Return and refund policy", schema: policySchema, instruction: "Write the return and refund policy for a US store. State who pays return shipping and the exact window." },
  { kind: "privacy_policy", title: "Privacy policy", schema: policySchema, instruction: "Write a privacy policy covering data collected, purpose, third parties, cookies, CCPA rights and contact route. Note where the operator must fill in real details." },
  { kind: "terms", title: "Terms of service", schema: policySchema, instruction: "Write terms of service for a US ecommerce store. Flag anything that needs a lawyer rather than pretending it does not." },
  { kind: "order_tracking_plan", title: "Order tracking plan", schema: listSchema, instruction: "Design the order tracking page and the notification plan: what the customer sees at each stage and what the operator must do to keep it true." },
  { kind: "seo", title: "SEO metadata", schema: seoSchema, instruction: "Write SEO titles and meta descriptions for home, product, collection, FAQ, about, contact and each policy page.", tier: "cheap" },
  { kind: "email_optin", title: "Email opt-in", schema: genericContentSchema, instruction: "Design the email opt-in: placement, incentive that is not a fake discount, and the copy." },
  { kind: "trust_sections", title: "Trust sections", schema: listSchema, instruction: "Design trust-building sections appropriate for a brand with no reviews yet: policy transparency, real support contact, payment security, materials honesty." },
  { kind: "mobile_structure", title: "Mobile-first structure", schema: listSchema, instruction: "Specify the mobile page structure and interaction rules: section order, thumb reach, sticky elements, image sizes, and what to defer below the fold.", tier: "cheap" },
  { kind: "photo_shot_list", title: "Product photography shot list", schema: listSchema, instruction: "Write the photography shot list: hero, scale, detail, in-use, packaging, comparison. Include framing and lighting notes.", tier: "cheap" },
  { kind: "ugc_shot_list", title: "UGC video shot list", schema: listSchema, instruction: "Write the UGC video shot list: hooks to film, angles, b-roll, and what the creator must not say.", tier: "cheap" },
  { kind: "launch_checklist", title: "Store launch checklist", schema: listSchema, instruction: "Write the pre-launch checklist: test order, payment, taxes, shipping rates, policies live, tracking, analytics, email flows, mobile check, page speed.", tier: "cheap" },
];

export const DRAFT_SPECS = SPECS.map((s) => ({ kind: s.kind, title: s.title }));

const SYSTEM = `You are a direct-response ecommerce copywriter and conversion designer working on one product for one small US brand.

HARD RULES, in priority order
1. You may only assert facts that appear in the APPROVED CLAIMS list. If a claim you want to make is not in that list, either drop it or rewrite it as a question the operator must verify. List every claim you relied on in claimsUsed.
2. Never write, in any form: invented reviews or testimonials, customer counts, "as seen on", scarcity or countdowns, struck-through reference prices, guarantees of outcome, medical or health claims, or a delivery promise other than the approved delivery estimate.
3. The brand is new and has no reviews. Write copy that converts without social proof rather than pretending it exists.
4. Objection handling beats adjectives. At this price the buyer's real questions are about durability, returns, delivery risk and whether the brand will still exist in six months. Answer those.
5. Write for mobile first. Short paragraphs, scannable, one idea per block.
6. Output valid JSON only, matching the requested shape exactly.`;

function contextFor(input: {
  productName: string;
  analysis: Record<string, unknown>;
  decision: {
    targetPriceCents: number;
    deliveryEstimateMin: number;
    deliveryEstimateMax: number;
    claimsAllowed: string[];
    claimsProhibited: string[];
  };
  supplierName: string | null;
  brandName: string | null;
}): string {
  const a = input.analysis as Record<string, unknown>;
  return `PRODUCT
Name: ${input.productName}
Approved selling price: $${(input.decision.targetPriceCents / 100).toFixed(2)}
Approved delivery estimate: ${input.decision.deliveryEstimateMin}-${input.decision.deliveryEstimateMax} days
Primary supplier: ${input.supplierName ?? "not recorded"}
Working brand name: ${input.brandName ?? "not chosen yet - propose one"}

CUSTOMER
Problem: ${String(a.customerProblem ?? "not recorded")}
Buyer: ${String(a.targetBuyer ?? "not recorded")}
Known objections: ${JSON.stringify(a.mainObjections ?? [])}
Known quality risks: ${JSON.stringify(a.qualityRisks ?? [])}
Known shipping risks: ${JSON.stringify(a.shippingRisks ?? [])}

APPROVED CLAIMS - the complete set of factual assertions you may make
${input.decision.claimsAllowed.map((c) => `- ${c}`).join("\n") || "- (none approved yet: write around facts entirely and say so)"}

PROHIBITED CLAIMS - never assert these, in any wording
${input.decision.claimsProhibited.map((c) => `- ${c}`).join("\n") || "- (none listed)"}`;
}

export async function generateDrafts(
  scope: Scope,
  buildId: string,
  kinds: DraftKind[],
): Promise<{ written: number; blocked: number }> {
  await assertWritesAllowed(scope);

  const [build] = await db
    .select()
    .from(storeBuilds)
    .where(and(eq(storeBuilds.id, buildId), eq(storeBuilds.storeId, scope.storeId)))
    .limit(1);
  if (!build) throw new Error("Store build not found.");

  const [decision] = await db
    .select()
    .from(productDecisions)
    .where(eq(productDecisions.id, build.decisionId))
    .limit(1);
  if (!decision) throw new Error("Product decision not found.");

  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(eq(productOpportunities.id, decision.opportunityId))
    .limit(1);

  const supplier = decision.primarySupplierId
    ? (await db.select().from(suppliers).where(eq(suppliers.id, decision.primarySupplierId)).limit(1))[0]
    : undefined;

  const claimsAllowed = decision.claimsAllowed as string[];
  const claimsProhibited = decision.claimsProhibited as string[];

  const context = contextFor({
    productName: opportunity?.name ?? "the product",
    analysis: (opportunity?.analysis as Record<string, unknown>) ?? {},
    decision: {
      targetPriceCents: decision.targetPriceCents,
      deliveryEstimateMin: decision.deliveryEstimateMin,
      deliveryEstimateMax: decision.deliveryEstimateMax,
      claimsAllowed,
      claimsProhibited,
    },
    supplierName: supplier?.name ?? null,
    brandName: build.brandName,
  });

  let written = 0;
  let blocked = 0;

  for (const kind of kinds) {
    const spec = SPECS.find((s) => s.kind === kind);
    if (!spec) continue;

    try {
      const result = await generateStructured({
        scope,
        agentName: `store_builder:${spec.kind}`,
        tier: spec.tier ?? "frontier",
        system: SYSTEM,
        prompt: `${context}\n\nTASK: ${spec.instruction}\n\nReturn JSON only.`,
        schema: spec.schema,
        maxTokens: 9000,
        inputRefs: { buildId, kind: spec.kind },
      });

      // Deterministic scan runs on the final text. Nothing the model said about
      // its own compliance is trusted here.
      const findings = scanPayload(result.data);
      const claimed = ((result.data as { claimsUsed?: string[] }).claimsUsed ?? []) as string[];
      const claimCheck = checkClaims(claimed, claimsAllowed, claimsProhibited);

      const allFindings = [
        ...findings,
        ...claimCheck.prohibited.map((c) => ({
          category: "prohibited_claim",
          severity: "block" as const,
          match: c,
          reason: "This claim is on the prohibited list from the product decision.",
          rewrite: "Remove it entirely.",
        })),
        ...claimCheck.unsupported.map((c) => ({
          category: "unsupported_claim",
          severity: "warn" as const,
          match: c,
          reason: "This claim is not in the approved claim list, so nothing backs it.",
          rewrite: "Add it to approved claims with evidence, or cut it from the copy.",
        })),
      ];

      if (isBlocked(allFindings)) blocked++;

      await db.insert(storeDrafts).values({
        storeId: scope.storeId,
        buildId,
        agentRunId: result.agentRunId,
        kind: spec.kind,
        title: spec.title,
        content: result.data as never,
        claimsUsed: claimed as never,
        complianceFindings: allFindings as never,
        status: "draft",
      });
      written++;
    } catch (err) {
      log.warn("draft generation failed", { kind: spec.kind, error: (err as Error).message });
    }
  }

  await audit(scope, {
    actorType: "agent",
    actionType: "store_builder.generated",
    targetTable: "store_builds",
    targetId: buildId,
    afterState: { written, blocked, kinds },
  });

  return { written, blocked };
}
