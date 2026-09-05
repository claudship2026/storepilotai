import "server-only";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  creativeBatches,
  creativeAssets,
  productDecisions,
  productOpportunities,
} from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/claude";
import {
  creativeBatchSchema,
  shortItemsSchema,
  emailSequenceSchema,
  promptPackSchema,
} from "@/lib/ai/schemas";
import { assertWritesAllowed } from "@/lib/killswitch";
import { scanPayload, checkClaims, isBlocked } from "@/lib/compliance";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { log } from "@/lib/logger";
import type { Scope } from "@/lib/db/scoped";

type Kind =
  | "video_hook" | "static_hook" | "headline" | "primary_text" | "ugc_script" | "demo_script"
  | "problem_solution_script" | "founder_story_script" | "objection_angle" | "retargeting_concept"
  | "landing_angle" | "offer_test" | "ad_test_plan" | "email_welcome" | "email_abandoned_cart"
  | "email_post_purchase" | "email_review_request" | "creator_outreach" | "creator_brief"
  | "photo_brief" | "video_shot_list" | "image_prompt" | "storyboard_prompt";

type Job = {
  kind: Kind;
  title: string;
  count: number;
  schema: z.ZodTypeAny;
  instruction: string;
  tier?: "cheap" | "frontier";
  /** How to explode one model response into individual stored assets. */
  explode: (data: unknown) => Array<{ title: string; payload: unknown; claimsUsed: string[] }>;
};

const short = (data: unknown) =>
  (data as z.infer<typeof shortItemsSchema>).items.map((i) => ({
    title: i.text.slice(0, 120),
    payload: i,
    claimsUsed: i.claimsUsed,
  }));

const concepts = (data: unknown) =>
  (data as z.infer<typeof creativeBatchSchema>).concepts.map((c) => ({
    title: c.title,
    payload: c,
    claimsUsed: c.claimsUsed,
  }));

const sequence = (data: unknown) => {
  const s = data as z.infer<typeof emailSequenceSchema>;
  return s.emails.map((e) => ({
    title: `${s.sequenceName} · step ${e.step}: ${e.subject}`,
    payload: e,
    claimsUsed: e.claimsUsed,
  }));
};

export const CREATIVE_JOBS: Job[] = [
  { kind: "video_hook", title: "Video hooks", count: 15, schema: shortItemsSchema, explode: short,
    instruction: "Write 15 opening video hooks, each under 12 words, each a different angle: problem, pattern interrupt, demonstration, price objection, comparison, before/after, myth, question, statistic you can actually support, and so on. Name the angle for each." },
  { kind: "static_hook", title: "Static ad hooks", count: 15, schema: shortItemsSchema, explode: short,
    instruction: "Write 15 static-image ad hooks with the visual angle each assumes." },
  { kind: "headline", title: "Headlines", count: 15, schema: shortItemsSchema, explode: short, tier: "cheap",
    instruction: "Write 15 ad headlines under 40 characters each." },
  { kind: "primary_text", title: "Primary text", count: 15, schema: shortItemsSchema, explode: short,
    instruction: "Write 15 primary-text variants of 2 to 4 short paragraphs each." },
  { kind: "ugc_script", title: "UGC scripts", count: 10, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 10 UGC concepts as full ad concepts with scripts a creator can film on a phone." },
  { kind: "demo_script", title: "Product demo scripts", count: 5, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 5 product-demonstration ad concepts where the mechanism is visible on camera." },
  { kind: "problem_solution_script", title: "Problem-solution scripts", count: 5, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 5 problem-solution ad concepts." },
  { kind: "founder_story_script", title: "Founder story scripts", count: 5, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 5 founder-story concepts. The brand is genuinely new and small; the story must be tellable truthfully by a first-time operator. Do not invent a factory, a team, a decade of experience or a personal medical history." },
  { kind: "objection_angle", title: "Objection-handling angles", count: 5, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 5 ad concepts that each lead with a real objection and answer it." },
  { kind: "retargeting_concept", title: "Retargeting concepts", count: 5, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 5 retargeting concepts for people who viewed but did not buy." },
  { kind: "landing_angle", title: "Landing page angles", count: 3, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 3 distinct landing-page angles, each with the hero, the argument order and the metric that would prove it worked." },
  { kind: "offer_test", title: "Offer tests", count: 3, schema: creativeBatchSchema, explode: concepts,
    instruction: "Design 3 offer tests. No fake discounts and no invented anchor prices: use bundles, bonuses, extended returns or free shipping thresholds." },
  { kind: "ad_test_plan", title: "Ad test plans", count: 3, schema: creativeBatchSchema, explode: concepts,
    instruction: "Design 3 structured ad test plans with hypothesis, variables held constant, budget, duration, decision metric and kill criteria. Budgets must fit the operator's daily ad budget." },
  { kind: "email_welcome", title: "Welcome sequence", count: 1, schema: emailSequenceSchema, explode: sequence,
    instruction: "Write a 4-email welcome sequence." },
  { kind: "email_abandoned_cart", title: "Abandoned cart sequence", count: 1, schema: emailSequenceSchema, explode: sequence,
    instruction: "Write a 3-email abandoned-cart sequence. No fake urgency and no discount unless the operator has approved one." },
  { kind: "email_post_purchase", title: "Post-purchase sequence", count: 1, schema: emailSequenceSchema, explode: sequence,
    instruction: "Write a 4-email post-purchase sequence that sets shipping expectations honestly using the approved delivery estimate." },
  { kind: "email_review_request", title: "Review request sequence", count: 1, schema: emailSequenceSchema, explode: sequence,
    instruction: "Write a 3-email review-request sequence. Never offer payment or a discount in exchange for a positive review; incentives must be unconditional on sentiment and disclosed." },
  { kind: "creator_outreach", title: "Creator outreach", count: 5, schema: shortItemsSchema, explode: short,
    instruction: "Write 5 creator outreach messages for different creator sizes and platforms. State the disclosure requirement in each." },
  { kind: "creator_brief", title: "Creator briefs", count: 3, schema: creativeBatchSchema, explode: concepts,
    instruction: "Write 3 creator briefs: deliverables, do and don't list, required disclosure, claims they may and may not make, and usage rights." },
  { kind: "photo_brief", title: "Photography briefs", count: 3, schema: creativeBatchSchema, explode: concepts, tier: "cheap",
    instruction: "Write 3 photography briefs with shot lists, styling and lighting." },
  { kind: "video_shot_list", title: "Video shot lists", count: 3, schema: creativeBatchSchema, explode: concepts, tier: "cheap",
    instruction: "Write 3 video shot lists with timing per shot." },
];

const PROMPT_PACK_JOB: Job = {
  kind: "image_prompt",
  title: "Claude prompt pack",
  count: 1,
  schema: promptPackSchema,
  instruction:
    "Write image-generation prompts for ad creative and storyboard prompts for video concepts. Each prompt must describe an original scene: no brand names, no logos, no recognisable characters, no celebrity likeness, and no imitation of another company's advertising.",
  explode: (data) => {
    const p = data as z.infer<typeof promptPackSchema>;
    return [
      ...p.imagePrompts.map((i) => ({ title: `Image: ${i.purpose}`, payload: i, claimsUsed: [] })),
      ...p.storyboardPrompts.map((s) => ({ title: `Storyboard: ${s.concept}`, payload: s, claimsUsed: [] })),
    ];
  },
};

const SYSTEM = `You are a direct-response creative strategist writing ad and email drafts for a small new US brand.

HARD RULES
1. Every factual assertion must come from the APPROVED CLAIMS list. List what you used in claimsUsed. If a concept needs a claim that is not approved, change the concept.
2. Never produce: invented reviews, testimonials or customer counts; fake scarcity, countdowns or "selling fast"; fake discounts or struck-through prices; medical, health or outcome claims; guarantees of results; comparisons you cannot substantiate; or any delivery promise other than the approved estimate.
3. The brand has no reviews and no history. Concepts must work without social proof.
4. Compliance warnings must be specific and honest. If a concept carries risk, say which rule it brushes against and what would make it safe. Never write "none" to be agreeable.
5. Budgets are integer US cents and must be realistic against the operator's daily ad budget.
6. Output valid JSON only.`;

export async function generateCreative(
  scope: Scope,
  batchId: string,
  kinds: Kind[],
): Promise<{ written: number; blocked: number }> {
  await assertWritesAllowed(scope);

  const [batch] = await db
    .select()
    .from(creativeBatches)
    .where(and(eq(creativeBatches.id, batchId), eq(creativeBatches.storeId, scope.storeId)))
    .limit(1);
  if (!batch) throw new Error("Creative batch not found.");

  const [decision] = await db
    .select()
    .from(productDecisions)
    .where(eq(productDecisions.id, batch.decisionId))
    .limit(1);
  if (!decision) throw new Error("Product decision not found.");

  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(eq(productOpportunities.id, decision.opportunityId))
    .limit(1);

  const business = await getSetting(scope, "business_defaults");
  const claimsAllowed = decision.claimsAllowed as string[];
  const claimsProhibited = decision.claimsProhibited as string[];
  const a = (opportunity?.analysis as Record<string, unknown>) ?? {};

  const context = `PRODUCT
Name: ${opportunity?.name ?? "the product"}
Price: $${(decision.targetPriceCents / 100).toFixed(2)}
Approved delivery estimate: ${decision.deliveryEstimateMin}-${decision.deliveryEstimateMax} days
Daily ad test budget: $${(business.dailyAdBudgetCents / 100).toFixed(2)}
Market: ${business.targetCountry}

CUSTOMER
Problem: ${String(a.customerProblem ?? "not recorded")}
Buyer: ${String(a.targetBuyer ?? business.customerType)}
Objections: ${JSON.stringify(a.mainObjections ?? [])}

APPROVED CLAIMS
${claimsAllowed.map((c) => `- ${c}`).join("\n") || "- (none approved: write concepts that assert no product facts at all, and say so in complianceWarning)"}

PROHIBITED CLAIMS
${claimsProhibited.map((c) => `- ${c}`).join("\n") || "- (none listed)"}`;

  const jobs = [...CREATIVE_JOBS, PROMPT_PACK_JOB].filter((j) => kinds.includes(j.kind));
  let written = 0;
  let blocked = 0;

  for (const job of jobs) {
    try {
      const result = await generateStructured({
        scope,
        agentName: `creative:${job.kind}`,
        tier: job.tier ?? "frontier",
        system: SYSTEM,
        prompt: `${context}\n\nTASK: ${job.instruction}\n\nReturn JSON only.`,
        schema: job.schema,
        maxTokens: 12000,
        temperature: 0.7,
        inputRefs: { batchId, kind: job.kind },
      });

      for (const item of job.explode(result.data)) {
        const findings = scanPayload(item.payload);
        const claimCheck = checkClaims(item.claimsUsed, claimsAllowed, claimsProhibited);
        const all = [
          ...findings,
          ...claimCheck.prohibited.map((c) => ({
            category: "prohibited_claim",
            severity: "block" as const,
            match: c,
            reason: "On the prohibited list from the product decision.",
            rewrite: "Remove the claim and rebuild the concept without it.",
          })),
          ...claimCheck.unsupported.map((c) => ({
            category: "unsupported_claim",
            severity: "warn" as const,
            match: c,
            reason: "Not in the approved claim list.",
            rewrite: "Approve the claim with evidence, or cut it.",
          })),
        ];

        const isBlockedAsset = isBlocked(all);
        if (isBlockedAsset) blocked++;

        await db.insert(creativeAssets).values({
          storeId: scope.storeId,
          batchId,
          agentRunId: result.agentRunId,
          kind: job.kind,
          title: item.title,
          payload: item.payload as never,
          claimsUsed: item.claimsUsed as never,
          complianceFindings: all as never,
          blocked: isBlockedAsset,
          status: "draft",
        });
        written++;
      }
    } catch (err) {
      log.warn("creative generation failed", { kind: job.kind, error: (err as Error).message });
    }
  }

  await audit(scope, {
    actorType: "agent",
    actionType: "creative.generated",
    targetTable: "creative_batches",
    targetId: batchId,
    afterState: { written, blocked, kinds },
  });

  return { written, blocked };
}
