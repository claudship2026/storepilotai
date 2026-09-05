import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { researchProjects, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Textarea, Table, Td, Th, money } from "@/components/ui";
import { createProject } from "./actions";

export const dynamic = "force-dynamic";

export default async function ResearchPage() {
  const scope = await requireScope();
  const [defaults, projects] = await Promise.all([
    getSetting(scope, "business_defaults"),
    db
      .select({
        id: researchProjects.id,
        name: researchProjects.name,
        niche: researchProjects.niche,
        status: researchProjects.status,
        createdAt: researchProjects.createdAt,
        opportunities: sql<number>`(select count(*) from ${productOpportunities} po where po.project_id = ${researchProjects.id})::int`,
        best: sql<number>`(select coalesce(max(po.opportunity_score), 0) from ${productOpportunities} po where po.project_id = ${researchProjects.id})::int`,
      })
      .from(researchProjects)
      .where(eq(researchProjects.storeId, scope.storeId))
      .orderBy(desc(researchProjects.createdAt))
      .limit(25),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Research</h1>
        <p className="mt-1 text-sm text-ink-400">
          A brief plus whatever evidence you have becomes a ranked list of scored opportunities with
          real unit economics. Nothing is invented: fields with no evidence come back marked
          estimated or missing.
        </p>
      </header>

      <Card>
        <CardHeader
          title="New research project"
          description="Prefilled from your settings. Change anything for this run only."
        />
        <CardBody>
          <form action={createProject} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Project name">
                <Input name="name" placeholder="High-ticket home equipment, round 1" required />
              </Field>
              <Field label="Target country">
                <Input name="targetCountry" defaultValue={defaults.targetCountry} />
              </Field>
            </div>
            <Field label="Niche or product idea">
              <Input name="niche" defaultValue={defaults.niche} />
            </Field>
            <Field label="Customer type">
              <Input name="customerType" defaultValue={defaults.customerType} />
            </Field>
            <div className="grid gap-4 md:grid-cols-4">
              <Field label="Target price ($)">
                <Input name="targetPrice" defaultValue={(defaults.targetPriceCents / 100).toFixed(0)} />
              </Field>
              <Field label="Max landed cost ($)">
                <Input name="maxLandedCost" defaultValue={(defaults.maxLandedCostCents / 100).toFixed(0)} />
              </Field>
              <Field label="Min gross margin (%)">
                <Input name="minGrossMargin" defaultValue={(defaults.minGrossMarginBps / 100).toFixed(0)} />
              </Field>
              <Field label="Max shipping (days)">
                <Input name="maxShippingDays" type="number" defaultValue={defaults.maxShippingDays} />
              </Field>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Launch budget ($)">
                <Input name="launchBudget" defaultValue={(defaults.launchBudgetCents / 100).toFixed(0)} />
              </Field>
              <Field label="Categories to avoid" hint="One per line.">
                <Textarea name="avoidCategories" rows={4} defaultValue={defaults.avoidCategories.join("\n")} />
              </Field>
            </div>
            <Button type="submit" variant="primary">
              Create project
            </Button>
          </form>
        </CardBody>
      </Card>

      {projects.length > 0 ? (
        <Card>
          <CardHeader title="Projects" />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Project</Th>
                  <Th>Status</Th>
                  <Th>Opportunities</Th>
                  <Th>Best score</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-ink-400">{p.niche}</div>
                    </Td>
                    <Td>
                      <Badge tone={p.status === "complete" ? "good" : p.status === "running" ? "warn" : "neutral"}>
                        {p.status}
                      </Badge>
                    </Td>
                    <Td className="tabular-nums">{p.opportunities}</Td>
                    <Td className="tabular-nums">{p.best || "—"}</Td>
                    <Td>
                      <Link href={`/research/${p.id}`} className="text-xs text-accent hover:underline">
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

      <p className="text-xs text-ink-400">
        Break-even CAC at your current defaults ({money(defaults.targetPriceCents)} price,{" "}
        {money(defaults.maxLandedCostCents)} max landed cost) is roughly{" "}
        {money(defaults.targetPriceCents - defaults.maxLandedCostCents - Math.round(defaults.targetPriceCents * 0.029) - 30)}{" "}
        per order.
      </p>
    </div>
  );
}
