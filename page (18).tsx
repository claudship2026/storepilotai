import { requireScope } from "@/lib/auth/session";
import { getAllSettings } from "@/lib/settings";
import { monthToDateSpendUsd } from "@/lib/ai/claude";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Textarea } from "@/components/ui";
import {
  saveBusinessDefaults,
  saveSupplierWeights,
  saveFlags,
  saveAiBudget,
  toggleKillSwitch,
} from "./actions";

export const dynamic = "force-dynamic";

const FLAG_LABELS: Array<[keyof Awaited<ReturnType<typeof getAllSettings>>["feature_flags"], string, string]> = [
  ["research", "Research tab", "Phase 2"],
  ["suppliers", "Supplier comparison", "Phase 3"],
  ["storeBuilder", "Store Builder", "Phase 4"],
  ["creativeStudio", "Creative Studio", "Phase 5"],
  ["commandCenter", "Command Center", "Phase 6"],
  ["shopifyWrites", "Shopify write actions", "Phase 7 — keep off until the dev store is verified"],
];

export default async function SettingsPage() {
  const scope = await requireScope();
  const cfg = await getAllSettings(scope);
  const spend = await monthToDateSpendUsd(scope.storeId).catch(() => 0);
  const b = cfg.business_defaults;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-ink-400">
          Assumptions live here rather than in prompts or code, so changing one changes the whole
          system. Every save is audited.
        </p>
      </header>

      {/* Kill switch */}
      <Card className={cfg.kill_switch.enabled ? "border-bad/50" : undefined}>
        <CardHeader
          title="Kill switch"
          description="Blocks every external write and every agent invocation. Ingestion, dashboards and deterministic scoring keep running."
          action={
            <Badge tone={cfg.kill_switch.enabled ? "bad" : "good"}>
              {cfg.kill_switch.enabled ? "Engaged" : "Normal"}
            </Badge>
          }
        />
        <CardBody>
          <form action={toggleKillSwitch} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="enabled" value={cfg.kill_switch.enabled ? "false" : "true"} />
            <div className="min-w-64 flex-1">
              <Field label="Reason">
                <Input
                  name="reason"
                  defaultValue={cfg.kill_switch.reason}
                  placeholder="Why you are engaging or releasing it"
                />
              </Field>
            </div>
            <Button type="submit" variant={cfg.kill_switch.enabled ? "primary" : "danger"}>
              {cfg.kill_switch.enabled ? "Release kill switch" : "Engage kill switch"}
            </Button>
          </form>
          {cfg.kill_switch.engagedAt ? (
            <p className="mt-3 text-xs text-ink-400">
              Engaged {new Date(cfg.kill_switch.engagedAt).toLocaleString()}
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* Business defaults */}
      <Card>
        <CardHeader
          title="Business defaults"
          description="Seeds every research run, margin calculation and creative brief."
        />
        <CardBody>
          <form action={saveBusinessDefaults} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Target country">
                <Input name="targetCountry" defaultValue={b.targetCountry} />
              </Field>
              <Field label="Max delivery time (days)">
                <Input name="maxShippingDays" type="number" defaultValue={b.maxShippingDays} />
              </Field>
            </div>
            <Field label="Niche / category focus">
              <Input name="niche" defaultValue={b.niche} />
            </Field>
            <Field label="Customer type">
              <Input name="customerType" defaultValue={b.customerType} />
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Target selling price ($)">
                <Input name="targetPrice" defaultValue={(b.targetPriceCents / 100).toFixed(2)} />
              </Field>
              <Field label="Max landed cost ($)">
                <Input
                  name="maxLandedCost"
                  defaultValue={(b.maxLandedCostCents / 100).toFixed(2)}
                />
              </Field>
              <Field label="Min gross margin (%)">
                <Input name="minGrossMargin" defaultValue={(b.minGrossMarginBps / 100).toFixed(0)} />
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Launch budget ($)" hint="Total, including ads, apps and samples.">
                <Input name="launchBudget" defaultValue={(b.launchBudgetCents / 100).toFixed(2)} />
              </Field>
              <Field
                label="Daily ad test budget ($)"
                hint="Used to compute how many buyers a break-even CAC needs per day."
              >
                <Input name="dailyAdBudget" defaultValue={(b.dailyAdBudgetCents / 100).toFixed(2)} />
              </Field>
            </div>
            <Field label="Categories to avoid" hint="One per line. Research will not return these.">
              <Textarea
                name="avoidCategories"
                rows={7}
                defaultValue={b.avoidCategories.join("\n")}
              />
            </Field>
            <Button type="submit" variant="primary">
              Save defaults
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* Supplier weights */}
      <Card>
        <CardHeader
          title="Supplier score weights"
          description="Must total 100. Applied to every supplier comparison in Phase 3."
        />
        <CardBody>
          <form action={saveSupplierWeights} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-4">
              {(
                [
                  ["quality", "Quality / reviews"],
                  ["shipping", "Shipping speed"],
                  ["cost", "Landed cost"],
                  ["tracking", "Tracking visibility"],
                  ["inventory", "Inventory reliability"],
                  ["communication", "Communication"],
                  ["branding", "Branding capability"],
                  ["integration", "Integration"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input name={k} type="number" min={0} max={100} defaultValue={cfg.supplier_weights[k]} />
                </Field>
              ))}
            </div>
            <Button type="submit" variant="primary">
              Save weights
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* AI budget */}
      <Card>
        <CardHeader
          title="AI budget"
          description="The breaker disables agent runs at the ceiling. It never disables monitoring, and it never lets an unvalidated output through."
          action={<Badge tone={spend > cfg.ai_budget.monthlyUsd * 0.8 ? "warn" : "neutral"}>${spend.toFixed(2)} MTD</Badge>}
        />
        <CardBody>
          <form action={saveAiBudget} className="flex flex-wrap items-end gap-4">
            <Field label="Monthly ceiling ($)">
              <Input name="monthlyUsd" type="number" defaultValue={cfg.ai_budget.monthlyUsd} />
            </Field>
            <Field label="Alert at (%)">
              <Input name="alertAtPercent" type="number" defaultValue={cfg.ai_budget.alertAtPercent} />
            </Field>
            <Button type="submit" variant="primary">
              Save budget
            </Button>
          </form>
          <p className="mt-3 text-xs text-ink-400">
            Set a second, higher limit on the API key itself in the Anthropic console, so this
            application&apos;s breaker always trips first.
          </p>
        </CardBody>
      </Card>

      {/* Feature flags */}
      <Card>
        <CardHeader
          title="Feature flags"
          description="Phase gating. A tab stays inert until its flag is on, and Shopify writes stay off until you have tested against the dev store."
        />
        <CardBody>
          <form action={saveFlags} className="space-y-3">
            {FLAG_LABELS.map(([key, label, note]) => (
              <label key={key} className="flex items-start gap-3 rounded-md border border-ink-700 px-3 py-2.5">
                <input
                  type="checkbox"
                  name={key}
                  defaultChecked={cfg.feature_flags[key]}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="block text-sm text-ink-100">{label}</span>
                  <span className="block text-[11px] text-ink-400">{note}</span>
                </span>
              </label>
            ))}
            <Button type="submit" variant="primary">
              Save flags
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
