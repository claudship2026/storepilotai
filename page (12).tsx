import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvalRequests, approvalDecisions, actionExecutions } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { killSwitchState } from "@/lib/killswitch";
import { Badge, Button, Card, CardBody, CardHeader, Field, Table, Td, Th, Textarea, money } from "@/components/ui";
import { decideAction } from "../actions";

export const dynamic = "force-dynamic";

type Evidence = { label: string; detail: string; sourceUrl?: string };
type Alternative = { label: string; detail: string };

export default async function ApprovalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scope = await requireScope();

  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.storeId, scope.storeId)))
    .limit(1);
  if (!request) notFound();

  const [decisions, executions, ks] = await Promise.all([
    db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.approvalRequestId, id))
      .orderBy(asc(approvalDecisions.decidedAt)),
    db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.approvalRequestId, id))
      .orderBy(asc(actionExecutions.createdAt)),
    killSwitchState(scope),
  ]);

  const evidence = (request.evidence ?? []) as Evidence[];
  const alternatives = (request.alternatives ?? []) as Alternative[];
  const isPending = request.status === "pending";

  return (
    <div className="space-y-6">
      <div>
        <Link href="/approvals" className="text-xs text-ink-400 hover:text-ink-100">
          ← Approval queue
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{request.summary}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{request.actionType}</Badge>
          <Badge tone="accent">{request.targetSystem}</Badge>
          <Badge
            tone={
              request.riskLevel === "critical"
                ? "bad"
                : request.riskLevel === "high"
                  ? "warn"
                  : "neutral"
            }
          >
            {request.riskLevel} risk
          </Badge>
          <Badge tone={isPending ? "warn" : "good"}>{request.status}</Badge>
          {request.confidence ? (
            <span className="text-xs text-ink-400">
              confidence {(Number(request.confidence) * 100).toFixed(0)}%
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Exact change"
              description="This is the precise payload that will be sent if you approve. Nothing else happens."
            />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                  Current
                </p>
                <pre className="max-h-80 overflow-auto rounded-md border border-ink-700 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300">
                  {JSON.stringify(request.currentState ?? null, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                  Proposed
                </p>
                <pre className="max-h-80 overflow-auto rounded-md border border-accent/40 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-100">
                  {JSON.stringify(request.proposedAction, null, 2)}
                </pre>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Evidence" description="Why this is being proposed." />
            <CardBody>
              {evidence.length === 0 ? (
                <p className="text-xs text-ink-400">No evidence attached.</p>
              ) : (
                <ul className="space-y-3">
                  {evidence.map((e, i) => (
                    <li key={i} className="border-l-2 border-ink-700 pl-3">
                      <p className="text-xs font-medium text-ink-100">{e.label}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{e.detail}</p>
                      {e.sourceUrl ? (
                        <a
                          href={e.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="mt-0.5 inline-block text-[11px] text-accent hover:underline"
                        >
                          {e.sourceUrl}
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {isPending ? (
            <Card>
              <CardHeader
                title="Decide"
                description="Approve executes immediately and idempotently. Reject records the decision and executes nothing."
              />
              <CardBody className="space-y-4">
                {ks.enabled ? (
                  <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-ink-100">
                    Kill switch is engaged. Approving will record the decision but the write will be
                    blocked and queued rather than executed.
                  </p>
                ) : null}
                <form action={decideAction} className="space-y-4">
                  <input type="hidden" name="requestId" value={request.id} />
                  <Field label="Note (optional)" hint="Stored on the decision record.">
                    <Textarea name="note" rows={2} placeholder="Why you decided this way…" />
                  </Field>
                  <Field
                    label="Modified payload (optional)"
                    hint="Valid JSON. Used only if you choose Approve with modification."
                  >
                    <Textarea
                      name="modifiedPayload"
                      rows={4}
                      className="font-mono text-[11px]"
                      defaultValue={JSON.stringify(request.proposedAction, null, 2)}
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" name="decision" value="approved" variant="primary">
                      Approve
                    </Button>
                    <Button type="submit" name="decision" value="modified">
                      Approve with modification
                    </Button>
                    <Button type="submit" name="decision" value="info_requested" variant="ghost">
                      Request more info
                    </Button>
                    <Button type="submit" name="decision" value="rejected" variant="danger">
                      Reject
                    </Button>
                  </div>
                </form>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Impact and rollback" />
            <CardBody className="space-y-3 text-sm">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-ink-400">Financial impact</p>
                <p className="mt-0.5 tabular-nums">
                  {request.financialImpactMinCents == null
                    ? "Not estimated"
                    : `${money(request.financialImpactMinCents)} – ${money(request.financialImpactMaxCents ?? request.financialImpactMinCents)}`}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-ink-400">Rollback plan</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-300">{request.rollbackPlan}</p>
              </div>
              {request.recommendedDecision ? (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-400">Recommendation</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-300">
                    {request.recommendedDecision}
                  </p>
                </div>
              ) : null}
              {alternatives.length > 0 ? (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-400">Alternatives</p>
                  <ul className="mt-1 space-y-1.5">
                    {alternatives.map((a, i) => (
                      <li key={i} className="text-xs text-ink-300">
                        <span className="text-ink-100">{a.label}:</span> {a.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Decision history" />
            <CardBody className="p-0">
              {decisions.length === 0 ? (
                <p className="px-5 py-6 text-center text-xs text-ink-400">No decision yet.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Decision</Th>
                      <Th>Latency</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisions.map((d) => (
                      <tr key={d.id}>
                        <Td className="text-xs">{d.decision}</Td>
                        <Td className="text-xs tabular-nums">
                          {d.latencySeconds}s{" "}
                          {d.latencySeconds < 5 ? (
                            <Badge tone="warn">rubber stamp</Badge>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Execution" />
            <CardBody className="p-0">
              {executions.length === 0 ? (
                <p className="px-5 py-6 text-center text-xs text-ink-400">Not executed.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Status</Th>
                      <Th>Idempotency key</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {executions.map((e) => (
                      <tr key={e.id}>
                        <Td>
                          <Badge
                            tone={
                              e.status === "succeeded"
                                ? "good"
                                : e.status === "blocked_by_kill_switch"
                                  ? "bad"
                                  : "warn"
                            }
                          >
                            {e.status}
                          </Badge>
                          {e.error ? (
                            <p className="mt-1 text-[11px] text-bad">{e.error}</p>
                          ) : null}
                        </Td>
                        <Td className="font-mono text-[10px] break-all text-ink-400">
                          {e.idempotencyKey}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
