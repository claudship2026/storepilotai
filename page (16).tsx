import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { storeBuilds, storeDrafts, productDecisions, productOpportunities } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { shopifyConfigured } from "@/lib/shopify";
import { getSetting } from "@/lib/settings";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Table, Td, Th, money } from "@/components/ui";
import { proposeWebhookRegistration } from "./actions";

export const dynamic = "force-dynamic";

export default async function StoreBuilderIndex() {
  const scope = await requireScope();

  const [builds, flags] = await Promise.all([
    db
      .select({
        id: storeBuilds.id,
        brandName: storeBuilds.brandName,
        createdAt: storeBuilds.createdAt,
        productName: productOpportunities.name,
        priceCents: productDecisions.targetPriceCents,
        drafts: sql<number>`(select count(*) from ${storeDrafts} d where d.build_id = ${storeBuilds.id})::int`,
        published: sql<number>`(select count(*) from ${storeDrafts} d where d.build_id = ${storeBuilds.id} and d.status = 'published')::int`,
      })
      .from(storeBuilds)
      .innerJoin(productDecisions, eq(storeBuilds.decisionId, productDecisions.id))
      .innerJoin(productOpportunities, eq(productDecisions.opportunityId, productOpportunities.id))
      .where(eq(storeBuilds.storeId, scope.storeId))
      .orderBy(desc(storeBuilds.createdAt)),
    getSetting(scope, "feature_flags"),
  ]);

  const connected = shopifyConfigured();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Store Builder</h1>
        <p className="mt-1 text-sm text-ink-400">
          Drafts first. Every push to Shopify is a separate approval showing the exact HTML that will
          be sent.
        </p>
      </header>

      <Card className={connected ? undefined : "border-warn/40"}>
        <CardHeader
          title="Shopify connection"
          description={
            connected
              ? "Credentials are present. Reads work now; writes additionally require the Shopify write flag."
              : "Not connected. Add SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN and SHOPIFY_API_SECRET to .env, then restart."
          }
          action={
            <div className="flex items-center gap-2">
              <Badge tone={connected ? "good" : "warn"}>{connected ? "connected" : "not connected"}</Badge>
              <Badge tone={flags.shopifyWrites ? "good" : "neutral"}>
                writes {flags.shopifyWrites ? "enabled" : "disabled"}
              </Badge>
            </div>
          }
        />
        {connected ? (
          <CardBody className="flex flex-wrap items-center gap-3">
            <form action={proposeWebhookRegistration}>
              <Button size="sm" type="submit">
                Propose webhook registration
              </Button>
            </form>
            <p className="text-xs text-ink-400">
              Registers the 15 topics the Command Center needs. Goes through the approval queue like
              every other write.
            </p>
          </CardBody>
        ) : null}
      </Card>

      {builds.length === 0 ? (
        <EmptyState
          title="No store build yet"
          body="Approve a product on the Product & Supplier tab. That approval creates the build and unlocks drafting."
          action={
            <Link href="/suppliers" className="text-xs text-accent hover:underline">
              Go to Product &amp; Supplier
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader title="Builds" />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Brand</Th>
                  <Th>Price</Th>
                  <Th>Drafts</Th>
                  <Th>Pushed</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {builds.map((b) => (
                  <tr key={b.id}>
                    <Td className="font-medium">{b.productName}</Td>
                    <Td>{b.brandName ?? <span className="text-ink-400">not named</span>}</Td>
                    <Td className="tabular-nums">{money(b.priceCents)}</Td>
                    <Td className="tabular-nums">{b.drafts}</Td>
                    <Td className="tabular-nums">{b.published}</Td>
                    <Td>
                      <Link href={`/store-builder/${b.id}`} className="text-xs text-accent hover:underline">
                        Open
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
