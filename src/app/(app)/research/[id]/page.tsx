import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { researchProjects, evidenceItems, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Textarea,
  Provenance,
  money,
  bps,
} from "@/components/ui";
import { addEvidence, deleteEvidence, runResearchAction, selectOpportunity, uploadCsv } from "../actions";

export const dynamic = "force-dynamic";

type Analysis = {
  summary: string;
  customerProblem: string;
  targetBuyer: string;
  whyItMaySell: string;
  competitorPriceMinCents: number | null;
  competitorPriceMaxCents: number | null;
  estimatedProductCostCents: number | null;
  estimatedShippingCostCents: number | null;
  estimatedShippingDays: number | null;
  bundleIdeas: string[];
  mainObjections: string[];
  qualityRisks: string[];
  shippingRisks: string[];
  complianceNotes: string[];
  supplierNotes: string;
  evidence: Array<{ claim: string; source: string; provenance: string }>;
  verifiedVsEstimated: string;
  reasoning: string;
  saturationRisk: number;
  complianceRisk: number;
  returnRisk: number;
  shippingRisk: number;
  contentPotential: number;
  demandSignal: number;
  evidenceQuality: number;
  economics: { breakEvenCacCents: number; landedCostCents: number; grossMarginBps: number; meetsMarginFloor: boolean };
  scoreBreakdown: Record<string, number>;
};

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireScope();

  const [project] = await db
    .select()
    .from(researchProjects)
    .where(and(eq(researchProjects.id, id), eq(researchProjects.storeId, scope.storeId)))
    .limit(1);
  if (!project) notFound();

  const [evidence, opportunities] = await Promise.all([
    db.select().from(evidenceItems).where(eq(evidenceItems.projectId, id)),
    db
      .select()
      .from(productOpportunities)
      .where(eq(productOpportunities.projectId, id))
      .orderBy(desc(productOpportunities.opportunityScore)),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/research" className="text-xs text-ink-400 hover:text-ink-100">
          ← Research
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{project.name}</h1>
        <p className="mt-1 text-sm text-ink-400">
          {project.niche} · {project.targetCountry} · target {money(project.targetPriceCents)} · max landed{" "}
          {money(project.maxLandedCostCents)} · min margin {bps(project.minGrossMarginBps)} · ≤{project.maxShippingDays} days
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Evidence"
            description="Everything here is treated as untrusted data, never as instruction. The more you add, the higher the evidence ceiling on every score."
          />
          <CardBody className="space-y-5">
            <form action={addEvidence} className="space-y-3">
              <input type="hidden" name="projectId" value={id} />
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Type">
                  <Select name="kind" defaultValue="manual_url">
                    <option value="manual_url">Competitor / market URL</option>
                    <option value="supplier_url">Supplier URL</option>
                    <option value="pasted_reviews">Pasted reviews</option>
                    <option value="pasted_competitor">Pasted competitor data</option>
                    <option value="manual_note">Operator note</option>
                  </Select>
                </Field>
                <Field label="Label">
                  <Input name="label" placeholder="Amazon listing, 4.2★, 1.8k reviews" required />
                </Field>
                <Field label="URL (optional)">
                  <Input name="url" type="url" placeholder="https://…" />
                </Field>
              </div>
              <Field label="Content" hint="Paste the reviews, specs, prices or notes. Up to 60k characters.">
                <Textarea name="content" rows={4} />
              </Field>
              <Button type="submit" size="sm">
                Add evidence
              </Button>
            </form>

            <form action={uploadCsv} className="flex flex-wrap items-end gap-3 border-t border-ink-800 pt-4">
              <input type="hidden" name="projectId" value={id} />
              <Field label="CSV upload" hint="Product exports, keyword data, competitor scrapes. Max 2MB.">
                <input
                  type="file"
                  name="file"
                  accept=".csv,text/csv"
                  className="text-xs text-ink-300 file:mr-3 file:rounded file:border-0 file:bg-ink-800 file:px-3 file:py-1.5 file:text-xs file:text-ink-100"
                />
              </Field>
              <Button type="submit" size="sm">
                Upload
              </Button>
            </form>

            {evidence.length > 0 ? (
              <ul className="space-y-2 border-t border-ink-800 pt-4">
                {evidence.map((e) => (
                  <li key={e.id} className="flex items-start justify-between gap-3 rounded border border-ink-700 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone="neutral">{e.kind.replace("_", " ")}</Badge>
                        <span className="truncate text-sm">{e.label}</span>
                      </div>
                      {e.url ? <p className="mt-0.5 truncate text-[11px] text-accent">{e.url}</p> : null}
                      {e.content ? (
                        <p className="mt-1 line-clamp-2 text-[11px] text-ink-400">{e.content.slice(0, 200)}</p>
                      ) : null}
                    </div>
                    <form action={deleteEvidence}>
                      <input type="hidden" name="id" value={e.id} />
                      <input type="hidden" name="projectId" value={id} />
                      <Button size="sm" variant="ghost" type="submit">
                        Remove
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Run analysis" description="One Claude call, schema-validated, costed." />
          <CardBody className="space-y-4">
            <p className="text-xs leading-relaxed text-ink-400">
              {evidence.length === 0
                ? "No evidence yet. The run will still work, but every score will be capped by low evidence quality, and you will get a list of what to go and gather."
                : `${evidence.length} evidence item(s) attached. Scores are capped by how well this evidence actually supports them.`}
            </p>
            <form action={runResearchAction}>
              <input type="hidden" name="projectId" value={id} />
              <Button type="submit" variant="primary" className="w-full">
                {opportunities.length > 0 ? "Run again" : "Run research"}
              </Button>
            </form>
            <p className="text-[11px] text-ink-400">
              Typical cost is a few cents. The run is blocked if the kill switch is on or the monthly
              AI budget is spent.
            </p>
          </CardBody>
        </Card>
      </div>

      {opportunities.length === 0 ? (
        <EmptyState
          title="No opportunities yet"
          body="Add whatever evidence you have, then run the analysis. Each candidate comes back with unit economics computed here, not by the model."
        />
      ) : (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">
            Ranked opportunities ({opportunities.length})
          </h2>
          {opportunities.map((o) => {
            const a = o.analysis as unknown as Analysis;
            return (
              <Card key={o.id}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums text-lg font-semibold">{o.opportunityScore}</span>
                      <span>{o.name}</span>
                    </span>
                  }
                  description={a.summary}
                  action={
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          o.recommendation === "pursue"
                            ? "good"
                            : o.recommendation === "research_more"
                              ? "warn"
                              : "bad"
                        }
                      >
                        {o.recommendation.replace("_", " ")}
                      </Badge>
                    </div>
                  }
                />
                <CardBody className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
                    <Metric label="Suggested price" value={money(o.suggestedPriceCents)} />
                    <Metric label="Est. product cost" value={money(a.estimatedProductCostCents)} />
                    <Metric label="Est. shipping" value={money(a.estimatedShippingCostCents)} />
                    <Metric label="Landed cost" value={money(o.estimatedLandedCostCents)} />
                    <Metric
                      label="Gross margin"
                      value={bps(o.grossMarginBps)}
                      tone={a.economics?.meetsMarginFloor ? "good" : "bad"}
                    />
                    <Metric label="Break-even CAC" value={money(o.breakEvenCacCents)} />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <Block title="Customer problem" body={a.customerProblem} />
                    <Block title="Target buyer" body={a.targetBuyer} />
                    <Block title="Why it may sell" body={a.whyItMaySell} />
                    <Block
                      title="Competitor price range"
                      body={
                        a.competitorPriceMinCents == null
                          ? "Not established from the supplied evidence."
                          : `${money(a.competitorPriceMinCents)} – ${money(a.competitorPriceMaxCents)}`
                      }
                    />
                  </div>

                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <ListBlock title="Bundle / upsell ideas" items={a.bundleIdeas} />
                    <ListBlock title="Main objections" items={a.mainObjections} />
                    <ListBlock title="Quality / return risks" items={a.qualityRisks} />
                    <ListBlock title="Shipping risks" items={a.shippingRisks} />
                  </div>

                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <RiskBar label="Saturation" value={a.saturationRisk} />
                    <RiskBar label="Compliance / trademark" value={a.complianceRisk} />
                    <RiskBar label="Return risk" value={a.returnRisk} />
                    <RiskBar label="Shipping risk" value={a.shippingRisk} />
                    <RiskBar label="Content / UGC potential" value={a.contentPotential} invert />
                  </div>

                  <div className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                      Verified versus estimated
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-300">{a.verifiedVsEstimated}</p>
                    <p className="mt-2 text-[11px] text-ink-400">
                      Evidence quality {a.evidenceQuality}/100 — this caps the opportunity score.
                    </p>
                  </div>

                  {a.evidence?.length ? (
                    <details className="rounded-md border border-ink-700 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-accent">
                        Evidence sources ({a.evidence.length})
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {a.evidence.map((e, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <Provenance value={e.provenance} />
                            <span className="text-ink-300">
                              {e.claim} <span className="text-ink-400">— {e.source}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <details className="rounded-md border border-ink-700 px-3 py-2">
                    <summary className="cursor-pointer text-xs text-accent">
                      Score breakdown and reasoning
                    </summary>
                    <pre className="mt-2 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-ink-300">
                      {JSON.stringify(a.scoreBreakdown, null, 2)}
                    </pre>
                    <p className="mt-2 text-xs leading-relaxed text-ink-300">{a.reasoning}</p>
                    {a.supplierNotes ? (
                      <p className="mt-2 text-xs leading-relaxed text-ink-400">
                        Supplier notes: {a.supplierNotes}
                      </p>
                    ) : null}
                  </details>

                  <form action={selectOpportunity}>
                    <input type="hidden" name="opportunityId" value={o.id} />
                    <Button type="submit" variant={o.recommendation === "avoid" ? "secondary" : "primary"}>
                      Move to supplier comparison
                    </Button>
                  </form>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded border border-ink-700 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
      <div
        className={
          "mt-0.5 text-sm font-semibold tabular-nums " +
          (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-300">{body}</p>
    </div>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <ul className="mt-1 space-y-1">
        {(items ?? []).map((i, n) => (
          <li key={n} className="text-xs leading-relaxed text-ink-300">
            · {i}
          </li>
        ))}
        {(items ?? []).length === 0 ? <li className="text-xs text-ink-400">none identified</li> : null}
      </ul>
    </div>
  );
}

function RiskBar({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const v = value ?? 0;
  const bad = invert ? v < 40 : v > 60;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-ink-400">{label}</span>
        <span className="text-xs tabular-nums text-ink-300">{v}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-ink-800">
        <div
          className={"h-1.5 rounded-full " + (bad ? "bg-bad" : "bg-good")}
          style={{ width: `${Math.max(2, Math.min(100, v))}%` }}
        />
      </div>
    </div>
  );
}
