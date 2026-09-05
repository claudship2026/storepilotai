import "server-only";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { log } from "@/lib/logger";
import type { Scope } from "@/lib/db/scoped";

export type AuditEntry = {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  actionType: string;
  targetTable?: string | null;
  targetId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
  correlationId?: string;
};

/**
 * Insert-only. UPDATE and DELETE are revoked on this table at the database
 * level (see scripts/seed.ts), so a bug or a compromised process cannot
 * rewrite history.
 *
 * Pass `tx` when the audit row must commit or roll back with the action it
 * describes - an executed action must never exist without its log entry.
 */
export async function audit(
  scope: Pick<Scope, "storeId">,
  entry: AuditEntry,
  tx: Pick<typeof db, "insert"> = db,
): Promise<string> {
  const [row] = await tx
    .insert(auditLogs)
    .values({
      storeId: scope.storeId,
      correlationId: entry.correlationId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      actionType: entry.actionType,
      targetTable: entry.targetTable ?? null,
      targetId: entry.targetId ?? null,
      beforeState: (entry.beforeState ?? null) as never,
      afterState: (entry.afterState ?? null) as never,
      metadata: (entry.metadata ?? null) as never,
    })
    .returning({ id: auditLogs.id, correlationId: auditLogs.correlationId });

  log.info("audit", { actionType: entry.actionType, targetId: entry.targetId });
  return row!.correlationId;
}
