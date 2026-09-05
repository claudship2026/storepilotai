import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { stackItems } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Stat, money } from "@/components/ui";
import { generateStack, proposeAppInstall } from "./actions";

export const dynamic = "force-dynamic";

export default async function StackPage() {
  const scope = await requireScope();
  const items = await db
    .select()
    .from(stackItems)
    .where(eq(stackItems.storeId, scope.storeId))
    .orderBy(asc(stackItems.category));

  const essential = items.filter((i) => i.essentialBeforeLaunch);
  const monthly = items.reduce((a, i) => a + (i.freePlanAvailable ? 0 : (i.estimatedMonthlyCents ?? 0)), 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Recommended store stack</h1>
          <p className="mt-1 text-sm text-ink-400">
            The smallest set of apps that gets you to launch. Every app costs money, adds storefront
            scripts and slows mobile checkout, so the default answer to a category is no.
          </p>
        </div>
        <form action={generateStack}>
          <Button size="sm" variant="primary" type="submit">
            {items.length > 0 ? "Regenerate" : "Recommend a stack"}
          </Button>
        </form>
      </header>

      {items.length === 0 ? (
        <EmptyState
          title="No stack recommended yet"
          body="Generate a recommendation. It reads your approved product, price point and delivery window, and evaluates thirteen categories — recommending an app in a category only when the store genuinely needs one."
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Apps recommended" value={items.length} />
            <Stat label="Essential before launch" value={essential.length} />
            <Stat label="Est. monthly cost" value={money(monthly)} sub="excluding free plans" />
          </div>

          <div className="space-y-4">
            {items.map((i) => (
              <Card key={i.id} className={i.essentialBeforeLaunch ? "border-accent/40" : undefined}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {i.appName}
                      <Badge tone="neutral">{i.category}</Badge>
                      {i.essentialBeforeLaunch ? <Badge tone="accent">essential</Badge> : null}
                      {i.freePlanAvailable ? <Badge tone="good">free plan</Badge> : null}
                      <Badge tone={i.status === "approved" ? "good" : "neutral"}>{i.status}</Badge>
                    </span>
                  }
                  description={i.whyNeeded}
                  action={
                    <span className="text-sm tabular-nums text-ink-300">
                      {i.estimatedMonthlyCents == null ? "price unknown" : `${money(i.estimatedMonthlyCents)}/mo`}
                    </span>
                  }
                />
                <CardBody className="space-y-3">
                  <div className="grid gap-4 md:grid-cols-3">
                    <Col title="Data permissions" items={i.dataPermissions as string[]} tone="warn" />
                    <Col title="Setup steps" items={i.setupSteps as string[]} />
                    <Col title="Risks and downsides" items={i.risks as string[]} tone="warn" />
                  </div>
                  {(i.alternatives as string[]).length > 0 ? (
                    <p className="text-xs text-ink-400">
                      Alternatives: {(i.alternatives as string[]).join(", ")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    <form action={proposeAppInstall}>
                      <input type="hidden" name="stackItemId" value={i.id} />
                      <Button size="sm" variant="primary" type="submit" disabled={i.status !== "recommended"}>
                        Approve for installation
                      </Button>
                    </form>
                    {i.installUrl ? (
                      <a
                        href={i.installUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-xs text-accent hover:underline"
                      >
                        Open App Store listing
                      </a>
                    ) : (
                      <span className="text-[11px] text-ink-400">
                        No listing URL recorded — search the App Store by name.
                      </span>
                    )}
                    <span className="text-[11px] text-ink-400">
                      Installation is always manual. Nothing is installed on your behalf.
                    </span>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Col({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{title}</p>
      <ul className="mt-1 space-y-1">
        {(items ?? []).map((x, i) => (
          <li key={i} className={"text-xs leading-relaxed " + (tone === "warn" ? "text-warn/90" : "text-ink-300")}>
            · {x}
          </li>
        ))}
        {(items ?? []).length === 0 ? <li className="text-xs text-ink-400">none listed</li> : null}
      </ul>
    </div>
  );
}
