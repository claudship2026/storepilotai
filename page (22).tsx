import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creativeBatches, creativeAssets, productDecisions, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { CREATIVE_JOBS } from "@/lib/agents/creative";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, money } from "@/components/ui";
import { createBatch, generateCreativeAction, setAssetStatus } from "./actions";

export const dynamic = "force-dynamic";

type Finding = { category: string; severity: string; match: string; reason: string; rewrite: string };

export default async function CreativePage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string; kind?: string }>;
}) {
  const sp = await searchParams;
  const scope = await requireScope();

  const [decision] = await db
    .select({
      id: productDecisions.id,
      targetPriceCents: productDecisions.targetPriceCents,
      claimsAllowed: productDecisions.claimsAllowed,
      productName: productOpportunities.name,
    })
    .from(productDecisions)
    .innerJoin(productOpportunities, eq(productDecisions.opportunityId, productOpportunities.id))
    .where(eq(productDecisions.storeId, scope.storeId))
    .orderBy(desc(productDecisions.approvedAt))
    .limit(1);

  const batches = await db
    .select({
      id: creativeBatches.id,
      label: creativeBatches.label,
      createdAt: creativeBatches.createdAt,
      assets: sql<number>`(select count(*) from ${creativeAssets} a where a.batch_id = ${creativeBatches.id})::int`,
      blocked: sql<number>`(select count(*) from ${creativeAssets} a where a.batch_id = ${creativeBatches.id} and a.blocked)::int`,
    })
    .from(creativeBatches)
    .where(eq(creativeBatches.storeId, scope.storeId))
    .orderBy(desc(creativeBatches.createdAt));

  const activeBatch = sp.batch ?? batches[0]?.id;
  const assets = activeBatch
    ? await db
        .select()
        .from(creativeAssets)
        .where(eq(creativeAssets.batchId, activeBatch))
        .orderBy(creativeAssets.kind, desc(creativeAssets.createdAt))
    : [];

  const kinds = [...new Set(assets.map((a) => a.kind))];
  const activeKind = sp.kind && kinds.includes(sp.kind as never) ? sp.kind : kinds[0];
  const shown = assets.filter((a) => a.kind === activeKind);

  if (!decision) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Creative Studio</h1>
        </header>
        <EmptyState
          title="No approved product yet"
          body="Creative may only assert claims from an approved product decision. Approve a product on the Product & Supplier tab first — that is what makes 'no invented claims' enforceable rather than aspirational."
          action={
            <Link href="/suppliers" className="text-xs text-accent hover:underline">
              Go to Product &amp; Supplier
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Creative Studio</h1>
        <p className="mt-1 text-sm text-ink-400">
          Drafts only, nothing launches. Every asset is scanned against the prohibited-claims list and
          against the {(decision.claimsAllowed as string[]).length} claims you approved for{" "}
          {decision.productName} at {money(decision.targetPriceCents)}.
        </p>
      </header>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="New batch" />
          <CardBody>
            <form action={createBatch} className="space-y-3">
              <Field label="Label">
                <Input name="label" placeholder="Launch round 1" />
              </Field>
              <Button size="sm" type="submit" variant="primary">
                Create batch
              </Button>
            </form>
            {batches.length > 0 ? (
              <ul className="mt-4 space-y-1.5 border-t border-ink-800 pt-3">
                {batches.map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/creative?batch=${b.id}`}
                      className={
                        "flex items-center justify-between rounded px-2 py-1.5 text-xs " +
                        (b.id === activeBatch ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850")
                      }
                    >
                      <span className="truncate">{b.label}</span>
                      <span className="flex items-center gap-1.5">
                        <span className="tabular-nums text-ink-400">{b.assets}</span>
                        {b.blocked > 0 ? <Badge tone="bad">{b.blocked}</Badge> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Generate"
            description="A full run produces roughly 150 assets across 22 generators. Select a subset to spend less."
          />
          <CardBody>
            {activeBatch ? (
              <form action={generateCreativeAction} className="space-y-3">
                <input type="hidden" name="batchId" value={activeBatch} />
                <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto rounded border border-ink-700 p-2 md:grid-cols-3">
                  {[...CREATIVE_JOBS.map((j) => ({ kind: j.kind, title: `${j.title} (${j.count})` })), { kind: "image_prompt", title: "Claude prompt pack" }].map(
                    (j) => (
                      <label key={j.kind} className="flex items-center gap-2 text-xs text-ink-300">
                        <input
                          type="checkbox"
                          name="kinds"
                          value={j.kind}
                          defaultChecked
                          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                        />
                        <span className="truncate">{j.title}</span>
                      </label>
                    ),
                  )}
                </div>
                <Button type="submit" variant="primary" size="sm">
                  Generate selected
                </Button>
              </form>
            ) : (
              <p className="text-xs text-ink-400">Create a batch first.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {kinds.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <Link
              key={k}
              href={`/creative?batch=${activeBatch}&kind=${k}`}
              className={
                "rounded px-2.5 py-1 text-xs " +
                (k === activeKind ? "bg-accent text-ink-950" : "border border-ink-700 text-ink-300 hover:border-ink-400")
              }
            >
              {k.replace(/_/g, " ")} ({assets.filter((a) => a.kind === k).length})
            </Link>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        {shown.map((a) => {
          const findings = (a.complianceFindings as Finding[]) ?? [];
          const p = a.payload as Record<string, unknown>;
          return (
            <Card key={a.id} className={a.blocked ? "border-bad/40" : undefined}>
              <CardHeader
                title={a.title}
                action={
                  <div className="flex items-center gap-2">
                    {a.blocked ? <Badge tone="bad">blocked</Badge> : null}
                    {findings.length > 0 && !a.blocked ? <Badge tone="warn">{findings.length} warning</Badge> : null}
                    <Badge tone={a.status === "approved" ? "good" : "neutral"}>{a.status}</Badge>
                  </div>
                }
              />
              <CardBody className="space-y-3">
                {typeof p.hook === "string" ? (
                  <Detail label="Hook" value={p.hook as string} />
                ) : null}
                {typeof p.coreMessage === "string" ? <Detail label="Core message" value={p.coreMessage as string} /> : null}
                {typeof p.script === "string" ? <Detail label="Script" value={p.script as string} /> : null}
                {typeof p.body === "string" ? <Detail label="Body" value={p.body as string} /> : null}
                {typeof p.text === "string" ? <Detail label="Text" value={p.text as string} /> : null}
                {typeof p.prompt === "string" ? <Detail label="Prompt" value={p.prompt as string} /> : null}
                {typeof p.visualInstructions === "string" ? (
                  <Detail label="Visuals" value={p.visualInstructions as string} />
                ) : null}
                {typeof p.complianceWarning === "string" ? (
                  <Detail label="Compliance note from the writer" value={p.complianceWarning as string} />
                ) : null}
                <div className="flex flex-wrap gap-3 text-[11px] text-ink-400">
                  {typeof p.platform === "string" ? <span>platform: {p.platform}</span> : null}
                  {typeof p.funnelStage === "string" ? <span>stage: {p.funnelStage}</span> : null}
                  {typeof p.testMetric === "string" ? <span>metric: {p.testMetric}</span> : null}
                  {typeof p.suggestedTestBudgetCents === "number" ? (
                    <span>budget: {money(p.suggestedTestBudgetCents as number)}</span>
                  ) : null}
                  {(a.claimsUsed as string[]).length > 0 ? (
                    <span>claims: {(a.claimsUsed as string[]).join("; ")}</span>
                  ) : null}
                </div>

                {findings.length > 0 ? (
                  <ul className="space-y-1 rounded-md border border-ink-700 bg-ink-850 px-3 py-2">
                    {findings.map((f, i) => (
                      <li key={i} className="text-xs">
                        <Badge tone={f.severity === "block" ? "bad" : "warn"}>{f.category}</Badge>{" "}
                        <span className="text-ink-100">&ldquo;{f.match}&rdquo;</span>
                        <span className="text-ink-400"> — {f.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <details className="rounded-md border border-ink-700 px-3 py-1.5">
                  <summary className="cursor-pointer text-[11px] text-accent">Full payload</summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10px] text-ink-300">
                    {JSON.stringify(p, null, 2)}
                  </pre>
                </details>

                <div className="flex gap-2">
                  <form action={setAssetStatus}>
                    <input type="hidden" name="assetId" value={a.id} />
                    <input type="hidden" name="status" value="approved" />
                    <Button size="sm" type="submit" disabled={a.blocked}>
                      Approve
                    </Button>
                  </form>
                  <form action={setAssetStatus}>
                    <input type="hidden" name="assetId" value={a.id} />
                    <input type="hidden" name="status" value="rejected" />
                    <Button size="sm" variant="ghost" type="submit">
                      Reject
                    </Button>
                  </form>
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-200">{value}</p>
    </div>
  );
}
