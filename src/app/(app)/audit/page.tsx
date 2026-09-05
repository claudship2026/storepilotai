import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { requireScope } from "@/lib/auth/session";
import { Badge, Card, CardBody, CardHeader, EmptyState, Table, Td, Th } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const scope = await requireScope();
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.storeId, scope.storeId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-ink-400">
          Insert-only. UPDATE and DELETE are revoked on this table at the database level, so history
          cannot be rewritten by this application or by anything that compromises it.
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="No entries yet" body="Every login, setting change, approval decision and executed action lands here with its before and after state." />
      ) : (
        <Card>
          <CardHeader title={`Last ${rows.length} entries`} />
          <CardBody className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Change</Th>
                  <Th>Correlation</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap text-xs text-ink-400">
                      {r.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </Td>
                    <Td>
                      <Badge tone={r.actorType === "user" ? "accent" : "neutral"}>
                        {r.actorType}
                      </Badge>
                    </Td>
                    <Td className="font-mono text-xs">{r.actionType}</Td>
                    <Td className="text-xs text-ink-400">
                      {r.targetTable ? (
                        <>
                          {r.targetTable}
                          <br />
                          <span className="text-[10px]">{r.targetId}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      {r.beforeState || r.afterState ? (
                        <details>
                          <summary className="cursor-pointer text-[11px] text-accent">view</summary>
                          <pre className="mt-1.5 max-w-md overflow-auto rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[10px] text-ink-300">
                            {JSON.stringify(
                              { before: r.beforeState, after: r.afterState },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-[11px] text-ink-400">—</span>
                      )}
                    </Td>
                    <Td className="font-mono text-[10px] text-ink-400">
                      {r.correlationId.slice(0, 8)}
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
