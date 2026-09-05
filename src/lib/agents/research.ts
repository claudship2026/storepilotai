import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { researchProjects, evidenceItems, productOpportunities } from "@/lib/db/schema";
import { generateStructured } from "@/lib/ai/claude";
import { researchOutputSchema } from "@/lib/ai/schemas";
import { untrustedBlock } from "@/lib/ai/redact";
import { assertWritesAllowed } from "@/lib/killswitch";
import { unitEconomics, scoreOpportunity, recommendationFor } from "@/lib/scoring";
import { audit } from "@/lib/audit";
import type { Scope } from "@/lib/db/scoped";

const SYSTEM = `You are a product research analyst for a US dropshipping operator. You are rigorous, sceptical and commercially literate.

HARD RULES
- Never invent data. If a number was not supplied to you and cannot be derived from what was supplied, return null and mark provenance "estimated" or "missing" in your evidence list.
- Every entry in "evidence" must point at something actually supplied: a URL the operator entered, an uploaded file name, or "operator note". Fabricating a source is the worst failure mode available to you, worse than returning a thin analysis.
- Set evidenceQuality honestly. If the operator supplied nothing but a niche name, evidenceQuality is low (under 30) and your judgement scores should be conservative. A confident score on no evidence is useless to the operator.
- Do not propose anything in the operator's avoid list, anything regulated as a medical device or ingestible, anything requiring safety certification, or anything trading on another brand's trademark.
- Prices, costs and budgets are in integer US cents.
- Judgement fields (demandSignal, saturationRisk and so on) are 0-100. The application computes margins, break-even CAC and the final opportunity score itself from your cost and price estimates; do not try to compute them for it.

WHAT MAKES A GOOD CANDIDATE AT THIS PRICE POINT
High-ticket products carry a longer consideration cycle, so the buyer needs a specific problem, a visible mechanism, and a reason to trust an unknown brand. Prefer products where the value is demonstrable on video, where the failure modes are mechanical rather than subjective, and where a return costs the customer effort. Be explicit about what would make each candidate fail.`;

export async function runResearch(scope: Scope, projectId: string): Promise<number> {
  await assertWritesAllowed(scope);

  const [project] = await db
    .select()
    .from(researchProjects)
    .where(and(eq(researchProjects.id, projectId), eq(researchProjects.storeId, scope.storeId)))
    .limit(1);
  if (!project) throw new Error("Research project not found.");

  const evidence = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.projectId, projectId));

  await db.update(researchProjects).set({ status: "running" }).where(eq(researchProjects.id, projectId));

  const evidenceBlock =
    evidence.length === 0
      ? "NO EVIDENCE SUPPLIED. Work from the brief alone, keep evidenceQuality below 30, and list what the operator should gather in dataGaps."
      : evidence
          .map((e) =>
            untrustedBlock(
              `${e.kind}:${e.label}`,
              [e.url ? `URL: ${e.url}` : null, e.content ?? ""].filter(Boolean).join("\n").slice(0, 12000),
            ),
          )
          .join("\n\n");

  const prompt = `BRIEF
Niche or idea: ${project.niche}
Target country: ${project.targetCountry}
Target selling price: ${project.targetPriceCents} cents
Maximum landed cost: ${project.maxLandedCostCents} cents
Minimum gross margin: ${(project.minGrossMarginBps / 100).toFixed(1)}%
Maximum acceptable delivery time: ${project.maxShippingDays} days
Customer type: ${project.customerType}
Categories to avoid: ${(project.avoidCategories as string[]).join(", ") || "none stated"}
Launch budget: ${project.launchBudgetCents} cents

EVIDENCE SUPPLIED BY THE OPERATOR
${evidenceBlock}

TASK
Return between 3 and 6 candidate product opportunities that fit the brief. For each, fill every field of the schema. Where you are estimating rather than reporting, say so in verifiedVsEstimated in plain words the operator can act on.

Return JSON matching this shape:
{
  "products": [{
    "name": string, "summary": string, "customerProblem": string, "targetBuyer": string, "whyItMaySell": string,
    "competitorPriceMinCents": number|null, "competitorPriceMaxCents": number|null,
    "estimatedProductCostCents": number|null, "estimatedShippingCostCents": number|null,
    "suggestedPriceCents": number, "estimatedShippingDays": number|null,
    "bundleIdeas": string[], "mainObjections": string[], "qualityRisks": string[], "shippingRisks": string[], "complianceNotes": string[],
    "demandSignal": 0-100, "differentiation": 0-100, "contentPotential": 0-100, "supplierAvailability": 0-100,
    "saturationRisk": 0-100, "complianceRisk": 0-100, "returnRisk": 0-100, "shippingRisk": 0-100, "evidenceQuality": 0-100,
    "supplierNotes": string,
    "evidence": [{"claim": string, "source": string, "provenance": "verified"|"supplier_provided"|"estimated"|"missing"}],
    "verifiedVsEstimated": string, "reasoning": string
  }],
  "notes": string,
  "dataGaps": string[]
}`;

  const result = await generateStructured({
    scope,
    agentName: "product_research",
    tier: "frontier",
    system: SYSTEM,
    prompt,
    schema: researchOutputSchema,
    maxTokens: 16000,
    temperature: 0.5,
    inputRefs: { projectId, evidenceCount: evidence.length },
  });

  let written = 0;
  for (const p of result.data.products) {
    const econ = unitEconomics({
      sellingPriceCents: p.suggestedPriceCents,
      productCostCents: p.estimatedProductCostCents ?? 0,
      shippingCostCents: p.estimatedShippingCostCents ?? 0,
      minGrossMarginBps: project.minGrossMarginBps,
      dailyAdBudgetCents: 0,
    });

    const { score, breakdown } = scoreOpportunity({
      economics: econ,
      demandSignal: p.demandSignal,
      differentiation: p.differentiation,
      contentPotential: p.contentPotential,
      supplierAvailability: p.supplierAvailability,
      saturationRisk: p.saturationRisk,
      complianceRisk: p.complianceRisk,
      returnRisk: p.returnRisk,
      shippingRisk: p.shippingRisk,
      evidenceQuality: p.evidenceQuality,
      shippingDaysEstimate: p.estimatedShippingDays,
      maxShippingDays: project.maxShippingDays,
    });

    await db.insert(productOpportunities).values({
      storeId: scope.storeId,
      projectId,
      agentRunId: result.agentRunId,
      name: p.name,
      opportunityScore: score,
      analysis: { ...p, economics: econ, scoreBreakdown: breakdown, projectNotes: result.data.notes } as never,
      recommendation: recommendationFor(score, econ, p.complianceRisk),
      suggestedPriceCents: p.suggestedPriceCents,
      estimatedLandedCostCents: econ.landedCostCents,
      grossMarginBps: econ.grossMarginBps,
      breakEvenCacCents: econ.breakEvenCacCents,
    });
    written++;
  }

  await db.update(researchProjects).set({ status: "complete" }).where(eq(researchProjects.id, projectId));

  await audit(scope, {
    actorType: "agent",
    actorId: result.agentRunId,
    actionType: "research.completed",
    targetTable: "research_projects",
    targetId: projectId,
    afterState: { opportunities: written, costUsd: result.costUsd, dataGaps: result.data.dataGaps },
  });

  return written;
}
