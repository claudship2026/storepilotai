import Link from "next/link";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvalRequests } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { approvalHealth, pendingApprovals } from "@/lib/approvals";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Stat, Table, Td, Th, money } from "@/components/ui";
import { createTestApproval } from "./actions";

export const dynamic = "force-dynamic";

const RISK_TONE = { low: "neutral", medium: "accent", high: "warn", critical: "bad" } as const;

export default async function ApprovalsPage() {
  const scope = await requireScope();
  const [pending, health, decided] = await Promise.all([
    pendingApprovals(scope),
    approvalHealth(scope),
    db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.storeId, scope.storeId), ne(approvalRequests.status, "pending")),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(20),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Approval queue</h1>
          <p className="mt-1 text-sm text-ink-400">
            The only path from a proposal to a real change. Every write in this system passes
            through here.
          </p>
        </div>
        <form action={createTestApproval}>
          <Button type="submit" size="sm">
            Create test approval
          </Button>
        </form>
      </header>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Pending" value={pending.length} />
        <Stat label="Median decision time" value={`${health.medianSeconds}s`} />
        <Stat
          label="Decided under 5s"
          value={`${Math.round(health.rubberStampRate * 100)}%`}
          sub="Rubber-stamp rate. High means the queue is over-triggering."
          tone={health.rubberStampRate > 0.5 && health.count > 5 ? "warn" : undefined}
        />
      </div>

      {pending.length === 0 ? (
        <EmptyState
          title="Queue is clear"
          body="Nothing is waiting on you. Requests appear here whenever the system wants to write to Shopify, contact a customer, change a price, spend money, or select a supplier."
        />
      ) : (
        <Card>
          <CardHeader title="Waiting on you" />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Risk</Th>
                  <Th>Impact</Th>
                  <Th>Raised</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <div className="font-medium">{r.summary}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-ink-400">{r.actionType}</div>
                    </Td>
                    <Td className="text-xs">{r.targetSystem}</Td>
                    <Td>
                      <Badge tone={RISK_TONE[r.riskLevel]}>{r.riskLevel}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs tabular-nums">
                      {r.financialImpactMinCents == null
                        ? "—"
                        : `${money(r.financialImpactMinCents)} – ${money(r.financialImpactMaxCents ?? r.financialImpactMinCents)}`}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-400">
                      {r.createdAt.toISOString().slice(5, 16).replace("T", " ")}
                    </Td>
                    <Td>
                      <Link
                        href={`/approvals/${r.id}`}
                        className="text-xs text-accent hover:underline"
                      >
                        Review
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      {decided.length > 0 ? (
        <Card>
          <CardHeader title="Decided" description="Last 20 resolved requests." />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Outcome</Th>
                  <Th>When</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id}>
                    <Td className="text-sm">{r.summary}</Td>
                    <Td>
                      <Badge
                        tone={
                          r.status === "approved" || r.status === "modified"
                            ? "good"
                            : r.status === "rejected"
                              ? "bad"
                              : "neutral"
                        }
                      >
                        {r.status}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-ink-400">
                      {r.createdAt.toISOString().slice(5, 16).replace("T", " ")}
                    </Td>
                    <Td>
                      <Link
                        href={`/approvals/${r.id}`}
                        className="text-xs text-accent hover:underline"
                      >
                        Open
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
