import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productOpportunities, productDecisions } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { Badge, Card, CardBody, CardHeader, EmptyState, Table, Td, Th, money, bps } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SuppliersIndex() {
  const scope = await requireScope();

  const [selected, decisions] = await Promise.all([
    db
      .select()
      .from(productOpportunities)
      .where(and(eq(productOpportunities.storeId, scope.storeId), eq(productOpportunities.isSelected, true)))
      .orderBy(desc(productOpportunities.opportunityScore)),
    db
      .select({
        id: productDecisions.id,
        opportunityId: productDecisions.opportunityId,
        targetPriceCents: productDecisions.targetPriceCents,
        approvedAt: productDecisions.approvedAt,
      })
      .from(productDecisions)
      .where(eq(productDecisions.storeId, scope.storeId))
      .orderBy(desc(productDecisions.approvedAt)),
  ]);

  const decidedIds = new Set(decisions.map((d) => d.opportunityId));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Product &amp; Supplier Decision</h1>
        <p className="mt-1 text-sm text-ink-400">
          Compare suppliers side by side, then approve one product for the store build. Nothing is
          created in Shopify before that approval.
        </p>
      </header>

      {selected.length === 0 ? (
        <EmptyState
          title="No product selected yet"
          body="Run a research project and move a candidate here with 'Move to supplier comparison'."
          action={
            <Link href="/research" className="text-xs text-accent hover:underline">
              Go to Research
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader title="Selected candidates" />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Score</Th>
                  <Th>Price</Th>
                  <Th>Margin</Th>
                  <Th>Status</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {selected.map((o) => (
                  <tr key={o.id}>
                    <Td className="font-medium">{o.name}</Td>
                    <Td className="tabular-nums">{o.opportunityScore}</Td>
                    <Td className="tabular-nums">{money(o.suggestedPriceCents)}</Td>
                    <Td className="tabular-nums">{bps(o.grossMarginBps)}</Td>
                    <Td>
                      {decidedIds.has(o.id) ? (
                        <Badge tone="good">approved for build</Badge>
                      ) : (
                        <Badge tone="warn">awaiting decision</Badge>
                      )}
                    </Td>
                    <Td>
                      <Link href={`/suppliers/${o.id}`} className="text-xs text-accent hover:underline">
                        Compare suppliers
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
