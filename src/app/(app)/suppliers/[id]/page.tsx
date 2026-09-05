import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productOpportunities, suppliers, productDecisions } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
  Provenance,
  money,
} from "@/components/ui";
import { addSupplier, removeSupplier, runSupplierReview, approveProductForBuild } from "../actions";

export const dynamic = "force-dynamic";

type Review = {
  perSupplier: Array<{
    supplierName: string;
    strengths: string[];
    weaknesses: string[];
    defectRiskNote: string;
    qualitySignals: string;
    missingInformation: string[];
    questionsToAsk: string[];
  }>;
  primaryRecommendation: string;
  backupRecommendation: string;
  reasoning: string;
  claimsSupportable: string[];
  claimsToAvoid: string[];
};

const FIELDS = [
  ["name", "Supplier name"],
  ["source", "Source / platform"],
  ["productUrl", "Product URL"],
  ["productCost", "Product cost ($)"],
  ["shippingCost", "Shipping cost ($)"],
  ["deliveryDaysMin", "Delivery days min"],
  ["deliveryDaysMax", "Delivery days max"],
  ["processingDays", "Processing days"],
  ["fulfillmentOrigin", "Fulfilment origin"],
  ["inventoryStatus", "Inventory status"],
  ["rating", "Rating (0-5)"],
  ["reviewCount", "Review count"],
] as const;

export default async function SupplierComparison({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireScope();

  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(and(eq(productOpportunities.id, id), eq(productOpportunities.storeId, scope.storeId)))
    .limit(1);
  if (!opportunity) notFound();

  const [rows, weights, business, existingDecision] = await Promise.all([
    db.select().from(suppliers).where(eq(suppliers.opportunityId, id)).orderBy(desc(suppliers.reliabilityScore)),
    getSetting(scope, "supplier_weights"),
    getSetting(scope, "business_defaults"),
    db
      .select()
      .from(productDecisions)
      .where(eq(productDecisions.opportunityId, id))
      .orderBy(desc(productDecisions.approvedAt))
      .limit(1),
  ]);

  const analysis = opportunity.analysis as Record<string, unknown>;
  const review = analysis.supplierReview as Review | undefined;
  const decided = existingDecision[0];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/suppliers" className="text-xs text-ink-400 hover:text-ink-100">
          ← Product &amp; Supplier
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{opportunity.name}</h1>
        <p className="mt-1 text-sm text-ink-400">
          Score {opportunity.opportunityScore}/100 · suggested price {money(opportunity.suggestedPriceCents)} ·
          weights: quality {weights.quality}, shipping {weights.shipping}, cost {weights.cost}, tracking{" "}
          {weights.tracking}, inventory {weights.inventory}, comms {weights.communication}, branding{" "}
          {weights.branding}, integration {weights.integration}
        </p>
      </div>

      {decided ? (
        <div className="rounded-md border border-good/40 bg-good/10 px-4 py-3 text-sm">
          Approved for store build on {decided.approvedAt.toISOString().slice(0, 10)} at{" "}
          {money(decided.targetPriceCents)}.{" "}
          <Link href="/store-builder" className="text-accent hover:underline">
            Go to Store Builder
          </Link>
        </div>
      ) : null}

      {/* Comparison */}
      <Card>
        <CardHeader
          title={`Supplier comparison (${rows.length})`}
          description="Scores are computed here from your weights. Every value carries how it was obtained."
          action={
            rows.length > 0 ? (
              <form action={runSupplierReview}>
                <input type="hidden" name="opportunityId" value={id} />
                <Button size="sm" type="submit">
                  Run AI review
                </Button>
              </form>
            ) : null
          }
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-ink-400">
              Add at least two suppliers to compare. Anything you do not know can be left blank — the
              score will show it as missing rather than assuming a value.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 border-b border-ink-700 bg-ink-900 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                      Attribute
                    </th>
                    {rows.map((s) => (
                      <th key={s.id} className="border-b border-ink-700 px-4 py-2.5 text-left">
                        <div className="text-sm font-semibold">{s.name}</div>
                        <div className="mt-0.5 text-[11px] text-ink-400">{s.source}</div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span
                            className={
                              "text-lg font-semibold tabular-nums " +
                              ((s.reliabilityScore ?? 0) >= 70
                                ? "text-good"
                                : (s.reliabilityScore ?? 0) >= 50
                                  ? "text-warn"
                                  : "text-bad")
                            }
                          >
                            {s.reliabilityScore ?? "—"}
                          </span>
                          {s.isPrimary ? <Badge tone="good">primary</Badge> : null}
                          {s.isBackup ? <Badge tone="accent">backup</Badge> : null}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <Row label="Product URL" cells={rows.map((s) => (s.productUrl ? <a key={s.id} href={s.productUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">listing</a> : "—"))} />
                  <Row label="Product cost" prov={rows.map((s) => (s.fieldProvenance as Record<string, string>)?.productCost)} cells={rows.map((s) => money(s.productCostCents))} />
                  <Row label="Shipping cost" prov={rows.map((s) => (s.fieldProvenance as Record<string, string>)?.shippingCost)} cells={rows.map((s) => money(s.shippingCostCents))} />
                  <Row label="Total landed cost" cells={rows.map((s) => money(s.landedCostCents))} strong />
                  <Row label="Est. profit per order" cells={rows.map((s) => money(s.profitPerOrderCents))} strong />
                  <Row label="Delivery days" prov={rows.map((s) => (s.fieldProvenance as Record<string, string>)?.deliveryDays)} cells={rows.map((s) => (s.deliveryDaysMin || s.deliveryDaysMax ? `${s.deliveryDaysMin ?? "?"}–${s.deliveryDaysMax ?? "?"}` : "—"))} />
                  <Row label="Processing days" cells={rows.map((s) => s.processingDays ?? "—")} />
                  <Row label="Fulfilment origin" cells={rows.map((s) => s.fulfillmentOrigin ?? "—")} />
                  <Row label="Inventory status" cells={rows.map((s) => s.inventoryStatus ?? "—")} />
                  <Row label="Tracking" cells={rows.map((s) => (s.trackingAvailable == null ? "—" : s.trackingAvailable ? "yes" : "no"))} />
                  <Row label="Rating / reviews" prov={rows.map((s) => (s.fieldProvenance as Record<string, string>)?.rating)} cells={rows.map((s) => (s.rating ? `${Number(s.rating).toFixed(1)} / ${s.reviewCount ?? "?"}` : "—"))} />
                  <Row label="Quality signals" cells={rows.map((s) => s.qualitySignals ?? "—")} />
                  <Row label="Branding / private label" cells={rows.map((s) => (s.brandingAvailable == null ? "—" : s.brandingAvailable ? "available" : "no"))} />
                  <Row label="Communication" cells={rows.map((s) => s.communicationNote ?? "—")} />
                  <Row label="Sample available" cells={rows.map((s) => (s.sampleAvailable == null ? "—" : s.sampleAvailable ? "yes" : "no"))} />
                  <Row label="Integration" cells={rows.map((s) => s.integrationAvailable ?? "—")} />
                  <Row
                    label="Missing criteria"
                    cells={rows.map((s) => {
                      const raw = (s.fieldProvenance as Record<string, string>)?._score;
                      if (!raw) return "—";
                      try {
                        const parsed = JSON.parse(raw) as { missing: string[]; confidence: number };
                        return parsed.missing.length === 0
                          ? "none"
                          : `${parsed.missing.join(", ")} (confidence ${parsed.confidence})`;
                      } catch {
                        return "—";
                      }
                    })}
                  />
                  <tr>
                    <td className="sticky left-0 bg-ink-900 px-4 py-3 text-xs text-ink-400">Remove</td>
                    {rows.map((s) => (
                      <td key={s.id} className="px-4 py-3">
                        <form action={removeSupplier}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="opportunityId" value={id} />
                          <Button size="sm" variant="ghost" type="submit">
                            Remove
                          </Button>
                        </form>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Add supplier */}
      <Card>
        <CardHeader
          title="Add a supplier"
          description="Mark how you know each number. Blank is fine and honest; a guessed number is not."
        />
        <CardBody>
          <form action={addSupplier} className="space-y-4">
            <input type="hidden" name="opportunityId" value={id} />
            <div className="grid gap-4 md:grid-cols-3">
              {FIELDS.map(([name, label]) => (
                <Field key={name} label={label}>
                  <Input name={name} required={name === "name"} />
                </Field>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <Field label="Tracking available">
                <Select name="trackingAvailable" defaultValue="">
                  <option value="">unknown</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </Select>
              </Field>
              <Field label="Branding / private label">
                <Select name="brandingAvailable" defaultValue="">
                  <option value="">unknown</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </Select>
              </Field>
              <Field label="Sample available">
                <Select name="sampleAvailable" defaultValue="">
                  <option value="">unknown</option>
                  <option value="yes">yes</option>
                  <option value="no">no</option>
                </Select>
              </Field>
              <Field label="Integration" hint="API, DSers, CJ, CSV, none">
                <Input name="integrationAvailable" />
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Quality signals">
                <Textarea name="qualitySignals" rows={2} placeholder="What the reviews and photos actually show" />
              </Field>
              <Field label="Communication">
                <Textarea name="communicationNote" rows={2} placeholder="Response time and quality when you contacted them" />
              </Field>
            </div>
            <div className="grid gap-3 rounded-md border border-ink-700 p-3 md:grid-cols-4">
              <p className="col-span-full text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                How do you know these?
              </p>
              {(["productCost", "shippingCost", "deliveryDays", "rating"] as const).map((k) => (
                <Field key={k} label={k}>
                  <Select name={`prov_${k}`} defaultValue="supplier_provided">
                    <option value="verified">verified by me</option>
                    <option value="supplier_provided">supplier says</option>
                    <option value="estimated">my estimate</option>
                    <option value="missing">unknown</option>
                  </Select>
                </Field>
              ))}
            </div>
            <Button type="submit" variant="primary">
              Add supplier
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* AI review */}
      {review ? (
        <Card>
          <CardHeader title="AI supplier review" description="Judgement and gaps only. The score above is computed, not generated." />
          <CardBody className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-md border border-good/40 bg-good/5 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-good">Primary</p>
                <p className="mt-1 text-sm text-ink-200">{review.primaryRecommendation}</p>
              </div>
              <div className="rounded-md border border-accent/40 bg-accent/5 px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">Backup</p>
                <p className="mt-1 text-sm text-ink-200">{review.backupRecommendation}</p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-ink-300">{review.reasoning}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {review.perSupplier.map((s) => (
                <div key={s.supplierName} className="rounded-md border border-ink-700 px-3 py-2.5">
                  <p className="text-sm font-medium">{s.supplierName}</p>
                  <p className="mt-1.5 text-[11px] uppercase tracking-wide text-ink-400">Strengths</p>
                  <ul className="text-xs text-ink-300">{s.strengths.map((x, i) => <li key={i}>· {x}</li>)}</ul>
                  <p className="mt-1.5 text-[11px] uppercase tracking-wide text-ink-400">Weaknesses</p>
                  <ul className="text-xs text-ink-300">{s.weaknesses.map((x, i) => <li key={i}>· {x}</li>)}</ul>
                  <p className="mt-1.5 text-[11px] uppercase tracking-wide text-ink-400">Missing information</p>
                  <ul className="text-xs text-warn">{s.missingInformation.map((x, i) => <li key={i}>· {x}</li>)}</ul>
                  <p className="mt-1.5 text-[11px] uppercase tracking-wide text-ink-400">Ask them</p>
                  <ul className="text-xs text-ink-300">{s.questionsToAsk.map((x, i) => <li key={i}>· {x}</li>)}</ul>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Decision gate */}
      <Card className="border-accent/40">
        <CardHeader
          title="Approve product for store build"
          description="This is the gate. Store Builder and Creative Studio may assert nothing that is not on the allowed claims list."
        />
        <CardBody>
          <form action={approveProductForBuild} className="space-y-4">
            <input type="hidden" name="opportunityId" value={id} />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Primary supplier">
                <Select name="primarySupplierId" required defaultValue={rows[0]?.id ?? ""}>
                  <option value="">Choose…</option>
                  {rows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — score {s.reliabilityScore ?? "n/a"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Backup supplier">
                <Select name="backupSupplierId" defaultValue={rows[1]?.id ?? ""}>
                  <option value="">None</option>
                  {rows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Target selling price ($)">
                <Input
                  name="targetPrice"
                  defaultValue={((opportunity.suggestedPriceCents ?? business.targetPriceCents) / 100).toFixed(2)}
                />
              </Field>
              <Field label="Delivery estimate, min days">
                <Input name="deliveryMin" type="number" defaultValue={Math.max(3, business.maxShippingDays - 5)} />
              </Field>
              <Field label="Delivery estimate, max days">
                <Input name="deliveryMax" type="number" defaultValue={business.maxShippingDays} />
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Claims allowed"
                hint="One per line. These are the only facts the store and ads may assert. Everything else gets flagged."
              >
                <Textarea
                  name="claimsAllowed"
                  rows={8}
                  defaultValue={(review?.claimsSupportable ?? []).join("\n")}
                  placeholder={"Made from 6061 aluminium\nSupports up to 150kg\nShips from a US warehouse"}
                />
              </Field>
              <Field label="Claims prohibited" hint="One per line. Named explicitly so the scanner blocks them.">
                <Textarea
                  name="claimsProhibited"
                  rows={8}
                  defaultValue={(review?.claimsToAvoid ?? []).join("\n")}
                  placeholder={"Relieves back pain\nBest on the market\nLifetime guarantee"}
                />
              </Field>
            </div>
            <Button type="submit" variant="primary">
              Approve product for store build
            </Button>
            <p className="text-[11px] text-ink-400">
              Recorded as an approval request and decision in the audit chain. Still nothing in
              Shopify: the build produces drafts, and each push is approved separately.
            </p>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({
  label,
  cells,
  prov,
  strong,
}: {
  label: string;
  cells: React.ReactNode[];
  prov?: Array<string | undefined>;
  strong?: boolean;
}) {
  return (
    <tr>
      <td className="sticky left-0 border-b border-ink-800 bg-ink-900 px-4 py-2.5 text-xs text-ink-400">
        {label}
      </td>
      {cells.map((c, i) => (
        <td
          key={i}
          className={"border-b border-ink-800 px-4 py-2.5 text-sm " + (strong ? "font-semibold tabular-nums" : "")}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{c}</span>
            {prov?.[i] ? <Provenance value={prov[i]!} /> : null}
          </div>
        </td>
      ))}
    </tr>
  );
}
