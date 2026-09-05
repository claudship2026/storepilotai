import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, agentRuns } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { pendingApprovals, approvalHealth } from "@/lib/approvals";
import { killSwitchState } from "@/lib/killswitch";
import { getAllSettings } from "@/lib/settings";
import { monthToDateSpendUsd } from "@/lib/ai/claude";
import { Badge, Card, CardBody, CardHeader, Stat, Table, Td, Th, money } from "@/components/ui";

export const dynamic = "force-dynamic";

const PHASES = [
  { n: 1, label: "Shell, DB, auth, approvals, audit, kill switch", state: "done" },
  { n: 2, label: "Research tab and opportunity scoring", state: "next" },
  { n: 3, label: "Supplier comparison and product decision gate", state: "todo" },
  { n: 4, label: "Store Builder and Shopify write approvals", state: "todo" },
  { n: 5, label: "Creative Studio", state: "todo" },
  { n: 6, label: "Command Center monitoring and recommendations", state: "todo" },
  { n: 7, label: "Automation rules and live Shopify writes", state: "todo" },
] as const;

export default async function Dashboard() {
  const scope = await requireScope();
  const [pending, health, ks, cfg, spend, recentAudit, runs] = await Promise.all([
    pendingApprovals(scope),
    approvalHealth(scope),
    killSwitchState(scope),
    getAllSettings(scope),
    monthToDateSpendUsd(scope.storeId).catch(() => 0),
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.storeId, scope.storeId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(8),
    db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.storeId, scope.storeId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(5),
  ]);

  const budget = cfg.ai_budget.monthlyUsd;

  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Command overview</h1>
        <p className="mt-1 text-sm text-ink-400">
          Nothing reaches Shopify, a supplier, an ad account or a customer without an approval
          recorded below.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Pending approvals"
          value={pending.length}
          sub={pending.length ? "Waiting on you" : "Queue clear"}
          tone={pending.length > 5 ? "warn" : undefined}
        />
        <Stat
          label="Median approval time"
          value={`${health.medianSeconds}s`}
          sub={`${health.count} decisions · ${Math.round(health.rubberStampRate * 100)}% under 5s`}
          tone={health.rubberStampRate > 0.5 && health.count > 5 ? "warn" : undefined}
        />
        <Stat
          label="AI spend, month to date"
          value={`$${spend.toFixed(2)}`}
          sub={`Budget $${budget.toFixed(0)} · breaker trips at 100%`}
          tone={spend > budget * 0.8 ? "warn" : undefined}
        />
        <Stat
          label="External writes"
          value={ks.enabled ? "Blocked" : "Gated"}
          sub={ks.enabled ? "Kill switch on" : "Approval required for every write"}
          tone={ks.enabled ? "bad" : "good"}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent activity"
            description="Every state change in the system, newest first."
            action={
              <Link href="/audit" className="text-xs text-accent hover:underline">
                Full audit log
              </Link>
            }
          />
          <CardBody className="p-0">
            {recentAudit.length === 0 ? (
              <p className="px-5 py-8 text-center text-xs text-ink-400">
                No activity yet. Signing in and changing a setting will appear here.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Target</Th>
                  </tr>
                </thead>
                <tbody>
                  {recentAudit.map((row) => (
                    <tr key={row.id}>
                      <Td className="whitespace-nowrap text-xs text-ink-400">
                        {row.createdAt.toISOString().slice(5, 16).replace("T", " ")}
                      </Td>
                      <Td>
                        <Badge tone={row.actorType === "user" ? "accent" : "neutral"}>
                          {row.actorType}
                        </Badge>
                      </Td>
                      <Td className="font-mono text-xs">{row.actionType}</Td>
                      <Td className="text-xs text-ink-400">{row.targetId ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Build progress" description="Each phase ships on your go-ahead." />
          <CardBody>
            <ol className="space-y-2.5">
              {PHASES.map((p) => (
                <li key={p.n} className="flex items-start gap-2.5 text-sm">
                  <span
                    className={
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold " +
                      (p.state === "done"
                        ? "bg-good/20 text-good"
                        : p.state === "next"
                          ? "bg-accent/20 text-accent"
                          : "bg-ink-800 text-ink-400")
                    }
                  >
                    {p.n}
                  </span>
                  <span className={p.state === "todo" ? "text-ink-400" : "text-ink-100"}>
                    {p.label}
                  </span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Current operating assumptions"
            description="Edit these in Settings. They seed every research run."
          />
          <CardBody className="space-y-2 text-sm">
            <Row label="Market" value={cfg.business_defaults.targetCountry} />
            <Row label="Niche" value={cfg.business_defaults.niche} />
            <Row label="Target price" value={money(cfg.business_defaults.targetPriceCents)} />
            <Row label="Max landed cost" value={money(cfg.business_defaults.maxLandedCostCents)} />
            <Row
              label="Min gross margin"
              value={`${(cfg.business_defaults.minGrossMarginBps / 100).toFixed(0)}%`}
            />
            <Row label="Max delivery" value={`${cfg.business_defaults.maxShippingDays} days`} />
            <Row label="Launch budget" value={money(cfg.business_defaults.launchBudgetCents)} />
            <Row
              label="Daily ad budget"
              value={money(cfg.business_defaults.dailyAdBudgetCents)}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Recent Claude runs"
            description="Every call is schema-validated and costed before its output is usable."
          />
          <CardBody className="p-0">
            {runs.length === 0 ? (
              <p className="px-5 py-8 text-center text-xs text-ink-400">
                No agent runs yet. The Research tab in Phase 2 makes the first one.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Status</Th>
                    <Th>Tokens</Th>
                    <Th>Cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <Td className="text-xs">{r.agentName}</Td>
                      <Td>
                        <Badge tone={r.status === "completed" ? "good" : "warn"}>{r.status}</Badge>
                      </Td>
                      <Td className="text-xs tabular-nums text-ink-400">
                        {r.inputTokens + r.outputTokens}
                      </Td>
                      <Td className="text-xs tabular-nums">
                        ${(Number(r.costCents) / 100).toFixed(4)}
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
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-ink-800 pb-2 last:border-0">
      <span className="text-xs text-ink-400">{label}</span>
      <span className="text-right text-sm text-ink-100">{value}</span>
    </div>
  );
}
