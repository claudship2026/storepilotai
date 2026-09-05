import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeBuilds, storeDrafts, productDecisions, productOpportunities, suppliers } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { DRAFT_SPECS } from "@/lib/agents/store-builder";
import { renderDraftHtml, pushTargetFor } from "@/lib/render-draft";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, money } from "@/components/ui";
import { generateDraftsAction, proposeShopifyPush, setBrandName, setDraftStatus } from "../actions";

export const dynamic = "force-dynamic";

type Finding = { category: string; severity: string; match: string; reason: string; rewrite: string };

export default async function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireScope();

  const [build] = await db
    .select()
    .from(storeBuilds)
    .where(and(eq(storeBuilds.id, id), eq(storeBuilds.storeId, scope.storeId)))
    .limit(1);
  if (!build) notFound();

  const [decision] = await db.select().from(productDecisions).where(eq(productDecisions.id, build.decisionId)).limit(1);
  const [opportunity] = await db
    .select()
    .from(productOpportunities)
    .where(eq(productOpportunities.id, decision!.opportunityId))
    .limit(1);
  const primary = decision!.primarySupplierId
    ? (await db.select().from(suppliers).where(eq(suppliers.id, decision!.primarySupplierId)).limit(1))[0]
    : undefined;

  const drafts = await db
    .select()
    .from(storeDrafts)
    .where(eq(storeDrafts.buildId, id))
    .orderBy(asc(storeDrafts.createdAt));

  const byKind = new Map(drafts.map((d) => [d.kind, d]));
  const missing = DRAFT_SPECS.filter((s) => !byKind.has(s.kind));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/store-builder" className="text-xs text-ink-400 hover:text-ink-100">
          ← Store Builder
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          {build.brandName ? `${build.brandName} · ` : ""}
          {opportunity?.name}
        </h1>
        <p className="mt-1 text-sm text-ink-400">
          {money(decision!.targetPriceCents)} · delivery {decision!.deliveryEstimateMin}–
          {decision!.deliveryEstimateMax} days · supplier {primary?.name ?? "not recorded"} ·{" "}
          {(decision!.claimsAllowed as string[]).length} approved claims
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Brand name" description="Used in the product title and copy." />
          <CardBody>
            <form action={setBrandName} className="space-y-3">
              <input type="hidden" name="buildId" value={id} />
              <Field label="Brand name">
                <Input name="brandName" defaultValue={build.brandName ?? ""} placeholder="Not chosen yet" />
              </Field>
              <Button size="sm" type="submit">
                Save
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Generate drafts"
            description={`${drafts.length} of ${DRAFT_SPECS.length} sections drafted. Generating all of them is roughly 20 Claude calls.`}
          />
          <CardBody>
            <form action={generateDraftsAction} className="space-y-3">
              <input type="hidden" name="buildId" value={id} />
              <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto rounded border border-ink-700 p-2 md:grid-cols-3">
                {DRAFT_SPECS.map((s) => (
                  <label key={s.kind} className="flex items-center gap-2 text-xs text-ink-300">
                    <input
                      type="checkbox"
                      name="kinds"
                      value={s.kind}
                      defaultChecked={!byKind.has(s.kind)}
                      className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    />
                    <span className="truncate">{s.title}</span>
                    {byKind.has(s.kind) ? <span className="text-[10px] text-ink-400">✓</span> : null}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" size="sm">
                  Generate selected
                </Button>
                <span className="text-[11px] text-ink-400">
                  {missing.length > 0 ? `${missing.length} not yet drafted` : "All sections drafted"}
                </span>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold tracking-tight">Drafts</h2>
        {drafts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-700 px-6 py-10 text-center text-xs text-ink-400">
            No drafts yet. Select the sections you want and generate.
          </p>
        ) : (
          drafts.map((d) => {
            const findings = (d.complianceFindings as Finding[]) ?? [];
            const blocking = findings.filter((f) => f.severity === "block");
            const target = pushTargetFor(d.kind);
            const html = target ? renderDraftHtml(d.kind, d.content as Record<string, unknown>) : null;

            return (
              <Card key={d.id} className={blocking.length ? "border-bad/40" : undefined}>
                <CardHeader
                  title={d.title}
                  description={`${(d.claimsUsed as string[]).length} claim(s) used`}
                  action={
                    <div className="flex items-center gap-2">
                      {blocking.length > 0 ? <Badge tone="bad">{blocking.length} blocking</Badge> : null}
                      {findings.length - blocking.length > 0 ? (
                        <Badge tone="warn">{findings.length - blocking.length} warning</Badge>
                      ) : null}
                      {findings.length === 0 ? <Badge tone="good">clean</Badge> : null}
                      <Badge tone={d.status === "published" ? "good" : "neutral"}>{d.status}</Badge>
                    </div>
                  }
                />
                <CardBody className="space-y-3">
                  {findings.length > 0 ? (
                    <ul className="space-y-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
                      {findings.map((f, i) => (
                        <li key={i} className="text-xs">
                          <Badge tone={f.severity === "block" ? "bad" : "warn"}>{f.category}</Badge>{" "}
                          <span className="text-ink-100">&ldquo;{f.match}&rdquo;</span>
                          <span className="text-ink-400"> — {f.reason}</span>
                          <div className="mt-0.5 text-[11px] text-ink-400">Fix: {f.rewrite}</div>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <details className="rounded-md border border-ink-700 px-3 py-2">
                    <summary className="cursor-pointer text-xs text-accent">Draft content</summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded bg-ink-950 p-2.5 font-mono text-[10px] leading-relaxed text-ink-300">
                      {JSON.stringify(d.content, null, 2)}
                    </pre>
                  </details>

                  {html ? (
                    <details className="rounded-md border border-ink-700 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-accent">
                        Rendered HTML that would be sent to Shopify
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded bg-ink-950 p-2.5 font-mono text-[10px] text-ink-300">
                        {html}
                      </pre>
                    </details>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <form action={setDraftStatus}>
                      <input type="hidden" name="draftId" value={d.id} />
                      <input type="hidden" name="buildId" value={id} />
                      <input type="hidden" name="status" value="approved" />
                      <Button size="sm" type="submit" disabled={blocking.length > 0}>
                        Mark approved
                      </Button>
                    </form>
                    <form action={setDraftStatus}>
                      <input type="hidden" name="draftId" value={d.id} />
                      <input type="hidden" name="buildId" value={id} />
                      <input type="hidden" name="status" value="rejected" />
                      <Button size="sm" variant="ghost" type="submit">
                        Reject
                      </Button>
                    </form>
                    {target ? (
                      <form action={proposeShopifyPush}>
                        <input type="hidden" name="draftId" value={d.id} />
                        <input type="hidden" name="buildId" value={id} />
                        <Button size="sm" variant="primary" type="submit" disabled={blocking.length > 0}>
                          Propose push to Shopify
                        </Button>
                      </form>
                    ) : (
                      <span className="self-center text-[11px] text-ink-400">
                        Working document — not written to Shopify.
                      </span>
                    )}
                    {d.shopifyResourceId ? (
                      <span className="self-center text-[11px] text-good">
                        Shopify id {d.shopifyResourceId}
                      </span>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
