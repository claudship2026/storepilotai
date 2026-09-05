import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { recommendations, detectedSignals, costRecords } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { storeSummary, skuPerformance, dailySeries, windowOf } from "@/lib/metrics";
import { shopifyConfigured } from "@/lib/shopify";
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
  Stat,
  Table,
  Td,
  Th,
  Textarea,
  money,
  bps,
} from "@/components/ui";
import {
  syncNow,
  runAnalystAction,
  addCost,
  addAdSpend,
  addTraffic,
  addCustomerSignal,
  queueRecommendation,
  dismissRecommendation,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function CommandCenter() {
  const scope = await requireScope();
  const w = windowOf(14);

  const [summary, skus, series, recs, signals, costs, business] = await Promise.all([
    storeSummary(scope, w),
    skuPerformance(scope, w),
    dailySeries(scope, w),
    db
      .select()
      .from(recommendations)
      .where(eq(recommendations.storeId, scope.storeId))
      .orderBy(desc(recommendations.createdAt))
      .limit(30),
    db
      .select()
      .from(detectedSignals)
      .where(eq(detectedSignals.storeId, scope.storeId))
      .orderBy(desc(detectedSignals.detectedAt))
      .limit(20),
    db
      .select()
      .from(costRecords)
      .where(eq(costRecords.storeId, scope.storeId))
      .orderBy(desc(costRecords.createdAt))
      .limit(12),
    getSetting(scope, "business_defaults"),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const open = recs.filter((r) => r.status === "open");
  const maxRevenue = Math.max(1, ...series.map((s) => s.revenueCents));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
          <p className="mt-1 text-sm text-ink-400">
            Last 14 days. Metrics are computed deterministically; the AI only interprets signals the
            detector already verified against records.
          </p>
        </div>
        <div className="flex gap-2">
          <form action={syncNow}>
            <Button size="sm" type="submit" disabled={!shopifyConfigured()}>
              Sync &amp; detect
            </Button>
          </form>
          <form action={runAnalystAction}>
            <Button size="sm" variant="primary" type="submit">
              Run analyst
            </Button>
          </form>
        </div>
      </header>

      {!shopifyConfigured() ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-2.5 text-xs">
          Shopify is not connected, so orders cannot be synced. Cost, ad spend, traffic and customer
          signals can still be entered below, and detection runs on whatever data exists.
        </div>
      ) : null}

      {/* Money */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Revenue" value={money(summary.revenueCents)} sub={`${summary.orders} orders`} />
        <Stat
          label="Contribution profit"
          value={money(summary.contributionProfitCents)}
          sub="after COGS, fees, refunds and ad spend"
          tone={summary.contributionProfitCents < 0 ? "bad" : "good"}
        />
        <Stat label="AOV" value={money(summary.aovCents)} />
        <Stat
          label="Gross margin"
          value={bps(summary.grossMarginBps)}
          sub={`floor ${bps(business.minGrossMarginBps)}`}
          tone={summary.grossMarginBps < business.minGrossMarginBps ? "warn" : "good"}
        />
        <Stat
          label="Conversion rate"
          value={summary.conversionRate == null ? "—" : `${(summary.conversionRate * 100).toFixed(2)}%`}
          sub={summary.sessions ? `${summary.sessions} sessions` : "enter sessions below"}
        />
        <Stat
          label="CAC"
          value={money(summary.cacCents)}
          sub={`break-even ${money(summary.breakEvenCacCents)}`}
          tone={summary.cacCents > summary.breakEvenCacCents && summary.orders > 0 ? "bad" : undefined}
        />
        <Stat label="ROAS" value={summary.roas == null ? "—" : summary.roas.toFixed(2)} sub={money(summary.adSpendCents) + " spend"} />
        <Stat
          label="Refund rate"
          value={`${(summary.refundRate * 100).toFixed(1)}%`}
          tone={summary.refundRate > 0.06 ? "warn" : undefined}
        />
      </div>

      {series.length > 0 ? (
        <Card>
          <CardHeader title="Daily revenue and contribution" description="Bars are revenue; the line marks zero contribution." />
          <CardBody>
            <div className="flex h-32 items-end gap-1">
              {series.map((d) => {
                const h = Math.max(2, (d.revenueCents / maxRevenue) * 100);
                return (
                  <div key={d.id} className="flex flex-1 flex-col items-center gap-1" title={`${d.metricDate}: ${money(d.revenueCents)} revenue, ${money(d.contributionProfitCents)} contribution`}>
                    <div
                      className={"w-full rounded-t " + (d.contributionProfitCents < 0 ? "bg-bad/70" : "bg-accent/70")}
                      style={{ height: `${h}%` }}
                    />
                    <span className="text-[9px] text-ink-400">{d.metricDate.slice(8)}</span>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* Signals */}
      <Card>
        <CardHeader
          title={`Detected signals (${signals.length})`}
          description="Deterministic. No model involvement, so these are as reliable as the underlying records."
        />
        <CardBody className="p-0">
          {signals.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-ink-400">
              Nothing detected. Run sync &amp; detect after your first orders.
            </p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {signals.map((s) => (
                <li key={s.id} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge tone={s.severity === "critical" ? "bad" : s.severity === "warning" ? "warn" : "neutral"}>
                          {s.severity}
                        </Badge>
                        <span className="text-sm">{s.title}</span>
                      </div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] text-accent">evidence</summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-ink-300">
                          {JSON.stringify(s.evidence, null, 2)}
                        </pre>
                      </details>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-ink-400">{s.code}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Recommendations */}
      <Card>
        <CardHeader
          title={`Recommendations (${open.length} open)`}
          description="Each carries evidence, an impact estimate, confidence, risk, the exact change and a rollback plan."
        />
        <CardBody className="space-y-3">
          {recs.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-400">
              None yet. Run the analyst once there are signals or orders to interpret.
            </p>
          ) : (
            recs.map((r) => {
              const action = r.proposedAction as { kind: string; humanSummary: string; payload: unknown } | null;
              return (
                <div key={r.id} className="rounded-lg border border-ink-700 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{r.category}</Badge>
                        <Badge tone={r.riskLevel === "critical" || r.riskLevel === "high" ? "bad" : "neutral"}>
                          {r.riskLevel}
                        </Badge>
                        <Badge tone={r.status === "open" ? "warn" : "neutral"}>{r.status.replace(/_/g, " ")}</Badge>
                        <span className="text-xs text-ink-400">
                          confidence {r.confidence ? `${(Number(r.confidence) * 100).toFixed(0)}%` : "—"}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm font-medium">{r.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-300">{r.body}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[10px] uppercase tracking-wide text-ink-400">Est. impact</p>
                      <p className="text-sm tabular-nums">
                        {r.financialImpactMinCents == null
                          ? "not estimable"
                          : `${money(r.financialImpactMinCents)} – ${money(r.financialImpactMaxCents ?? r.financialImpactMinCents)}`}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-ink-400">Evidence</p>
                      <ul className="mt-0.5 space-y-0.5">
                        {(r.evidence as Array<{ label: string; detail: string }>).map((e, i) => (
                          <li key={i} className="text-[11px] text-ink-300">
                            <span className="text-ink-100">{e.label}:</span> {e.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      {(r.missingData as string[]).length > 0 ? (
                        <>
                          <p className="text-[10px] uppercase tracking-wide text-warn">
                            Missing before this is decidable
                          </p>
                          <ul className="mt-0.5 space-y-0.5">
                            {(r.missingData as string[]).map((m, i) => (
                              <li key={i} className="text-[11px] text-ink-300">
                                · {m}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {r.rollbackPlan ? (
                        <p className="mt-1.5 text-[11px] text-ink-400">Rollback: {r.rollbackPlan}</p>
                      ) : null}
                    </div>
                  </div>

                  {action ? (
                    <details className="mt-2 rounded border border-ink-700 px-2.5 py-1.5">
                      <summary className="cursor-pointer text-[11px] text-accent">
                        Exact change ({action.kind})
                      </summary>
                      <pre className="mt-1.5 max-h-56 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-ink-300">
                        {JSON.stringify(action.payload, null, 2)}
                      </pre>
                    </details>
                  ) : null}

                  {r.status === "open" ? (
                    <div className="mt-2.5 flex gap-2">
                      <form action={queueRecommendation}>
                        <input type="hidden" name="recommendationId" value={r.id} />
                        <Button size="sm" variant="primary" type="submit">
                          Send to approval queue
                        </Button>
                      </form>
                      <form action={dismissRecommendation}>
                        <input type="hidden" name="recommendationId" value={r.id} />
                        <Button size="sm" variant="ghost" type="submit">
                          Dismiss
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      {/* SKU performance */}
      {skus.length > 0 ? (
        <Card>
          <CardHeader title="Performance by SKU" description="Revenue-positive but contribution-negative rows are flagged." />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Units</Th>
                  <Th>Orders</Th>
                  <Th>Revenue</Th>
                  <Th>Refunds</Th>
                  <Th>Contribution</Th>
                  <Th>Costs</Th>
                </tr>
              </thead>
              <tbody>
                {skus.map((s) => (
                  <tr key={s.sku ?? s.title}>
                    <Td>
                      <div className="text-sm">{s.sku ?? "—"}</div>
                      <div className="text-[11px] text-ink-400">{s.title}</div>
                    </Td>
                    <Td className="tabular-nums">{s.units}</Td>
                    <Td className="tabular-nums">{s.orders}</Td>
                    <Td className="tabular-nums">{money(s.revenue)}</Td>
                    <Td className="tabular-nums">{money(s.refunds)}</Td>
                    <Td className={"tabular-nums " + (s.contribution < 0 ? "text-bad" : "text-good")}>
                      {money(s.contribution)}
                    </Td>
                    <Td>
                      <Badge tone={s.estimatedInputs ? "warn" : "good"}>
                        {s.estimatedInputs ? "estimated" : "verified"}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}

      {/* Data entry */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Costs"
            description="Append-only and effective-dated. A new entry never rewrites a historical margin."
          />
          <CardBody className="space-y-4">
            <form action={addCost} className="space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Cost type">
                  <Select name="costType" defaultValue="supplier_unit">
                    <option value="supplier_unit">Supplier unit cost ($)</option>
                    <option value="inbound_shipping">Inbound shipping ($)</option>
                    <option value="packaging">Packaging ($)</option>
                    <option value="transaction_fee_rate">Transaction fee rate (%)</option>
                    <option value="transaction_fee_fixed">Transaction fixed fee ($)</option>
                    <option value="operating_monthly">Operating cost, monthly ($)</option>
                  </Select>
                </Field>
                <Field label="SKU" hint="Blank applies it store-wide.">
                  <Input name="sku" />
                </Field>
                <Field label="Amount">
                  <Input name="amount" placeholder="0.00" required />
                </Field>
                <Field label="How do you know?">
                  <Select name="provenance" defaultValue="estimated">
                    <option value="verified">verified from an invoice</option>
                    <option value="estimated">estimated</option>
                  </Select>
                </Field>
              </div>
              <Field label="Source note">
                <Input name="sourceNote" placeholder="Supplier invoice 2026-08-14" />
              </Field>
              <Button size="sm" type="submit" variant="primary">
                Record cost
              </Button>
            </form>
            {costs.length > 0 ? (
              <ul className="space-y-1 border-t border-ink-800 pt-3 text-[11px] text-ink-400">
                {costs.map((c) => (
                  <li key={c.id}>
                    {c.effectiveFrom.toISOString().slice(0, 10)} · {c.costType} ·{" "}
                    {c.scopeValue ?? "global"} ·{" "}
                    {c.rateBps != null ? `${(c.rateBps / 100).toFixed(2)}%` : money(c.amountCents)} ·{" "}
                    <Badge tone={c.provenance === "verified" ? "good" : "warn"}>{c.provenance}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Ad spend" description="Manual or CSV-derived. Feeds CAC, ROAS and contribution profit." />
            <CardBody>
              <form action={addAdSpend} className="grid gap-3 md:grid-cols-2">
                <Field label="Date">
                  <Input name="spendDate" type="date" defaultValue={today} required />
                </Field>
                <Field label="Channel">
                  <Select name="channel" defaultValue="meta">
                    <option value="meta">Meta</option>
                    <option value="tiktok">TikTok</option>
                    <option value="google">Google</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Field label="Spend ($)">
                  <Input name="spend" placeholder="70.00" required />
                </Field>
                <Field label="Campaign reference">
                  <Input name="campaignRef" placeholder="optional" />
                </Field>
                <div className="md:col-span-2">
                  <Button size="sm" type="submit" variant="primary">
                    Record spend
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Sessions"
              description="The Admin API does not expose sessions, so conversion rate needs this input."
            />
            <CardBody>
              <form action={addTraffic} className="flex flex-wrap items-end gap-3">
                <Field label="Date">
                  <Input name="recordDate" type="date" defaultValue={today} required />
                </Field>
                <Field label="Sessions">
                  <Input name="sessions" type="number" placeholder="420" required />
                </Field>
                <Button size="sm" type="submit" variant="primary">
                  Record
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Customer signals"
              description="Complaints, questions and review themes. Text is PII-redacted before it is stored."
            />
            <CardBody>
              <form action={addCustomerSignal} className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Kind">
                    <Select name="kind" defaultValue="complaint">
                      <option value="complaint">Complaint</option>
                      <option value="question">Pre-sale question</option>
                      <option value="review">Review theme</option>
                      <option value="return">Return reason</option>
                    </Select>
                  </Field>
                  <Field label="Theme" hint="Short and repeatable, so repeats can be counted.">
                    <Input name="theme" placeholder="shipping took too long" required />
                  </Field>
                </div>
                <Field label="Detail">
                  <Textarea name="detail" rows={2} />
                </Field>
                <Button size="sm" type="submit" variant="primary">
                  Record signal
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
