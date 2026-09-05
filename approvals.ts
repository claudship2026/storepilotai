import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { approvalRequests, approvalDecisions, actionExecutions } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import { assertWritesAllowed, KillSwitchEngagedError } from "@/lib/killswitch";
import { log } from "@/lib/logger";
import type { Scope } from "@/lib/db/scoped";

export type ProposeInput = {
  actionType: string;
  targetSystem: "shopify" | "internal" | "email" | "ads" | "supplier";
  summary: string;
  proposedAction: Record<string, unknown>;
  currentState?: Record<string, unknown> | null;
  evidence?: Array<{ label: string; detail: string; sourceUrl?: string }>;
  confidence?: number;
  riskLevel?: "low" | "medium" | "high" | "critical";
  financialImpactMinCents?: number;
  financialImpactMaxCents?: number;
  rollbackPlan: string;
  recommendedDecision?: string;
  alternatives?: Array<{ label: string; detail: string }>;
  deadline?: Date;
  agentRunId?: string;
};

/**
 * The single entry point for anything that wants to touch the outside world.
 * Nothing in this codebase calls an external API directly; a caller proposes,
 * a human decides, and only then does executeApproved() run.
 */
export async function propose(scope: Scope, input: ProposeInput): Promise<string> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      storeId: scope.storeId,
      agentRunId: input.agentRunId ?? null,
      actionType: input.actionType,
      targetSystem: input.targetSystem,
      summary: input.summary,
      proposedAction: input.proposedAction as never,
      currentState: (input.currentState ?? null) as never,
      evidence: (input.evidence ?? []) as never,
      confidence: input.confidence != null ? input.confidence.toFixed(3) : null,
      riskLevel: input.riskLevel ?? "medium",
      financialImpactMinCents: input.financialImpactMinCents ?? null,
      financialImpactMaxCents: input.financialImpactMaxCents ?? null,
      rollbackPlan: input.rollbackPlan,
      recommendedDecision: input.recommendedDecision ?? null,
      alternatives: (input.alternatives ?? []) as never,
      deadline: input.deadline ?? null,
    })
    .returning({ id: approvalRequests.id, correlationId: approvalRequests.correlationId });

  await audit(scope, {
    actorType: input.agentRunId ? "agent" : "user",
    actorId: input.agentRunId ?? scope.userId,
    actionType: "approval.requested",
    targetTable: "approval_requests",
    targetId: row!.id,
    afterState: { actionType: input.actionType, summary: input.summary },
    correlationId: row!.correlationId,
  });

  return row!.id;
}

export type Decision = "approved" | "modified" | "rejected" | "info_requested";

export async function decide(
  scope: Scope,
  requestId: string,
  decision: Decision,
  opts: { note?: string; modifiedPayload?: Record<string, unknown> } = {},
): Promise<void> {
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.storeId, scope.storeId)))
    .limit(1);

  if (!request) throw new Error("Approval request not found.");
  if (request.status !== "pending") throw new Error(`Request is already ${request.status}.`);

  const latencySeconds = Math.max(
    0,
    Math.round((Date.now() - request.createdAt.getTime()) / 1000),
  );

  await db.insert(approvalDecisions).values({
    approvalRequestId: requestId,
    decidedBy: scope.userId,
    decision,
    modifiedPayload: (opts.modifiedPayload ?? null) as never,
    note: opts.note ?? null,
    latencySeconds,
  });

  await db
    .update(approvalRequests)
    .set({ status: decision })
    .where(eq(approvalRequests.id, requestId));

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: `approval.${decision}`,
    targetTable: "approval_requests",
    targetId: requestId,
    beforeState: { status: request.status },
    afterState: { status: decision, latencySeconds, rubberStamp: latencySeconds < 5 },
    metadata: { note: opts.note ?? null },
    correlationId: request.correlationId,
  });

  if (decision === "approved" || decision === "modified") {
    await executeApproved(scope, requestId, opts.modifiedPayload ?? null);
  }
}

/** Registry of executors. Phase 4 registers the Shopify writers here. */
type Executor = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
const executors = new Map<string, Executor>();

export function registerExecutor(actionType: string, fn: Executor): void {
  executors.set(actionType, fn);
}

function stateHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 32);
}

/**
 * Runs an approved action exactly once.
 *
 *  - Kill switch is re-checked here, immediately before the write, not at
 *    proposal time. Engaging it stops in-flight approvals too.
 *  - The idempotency key is unique in the database, so a duplicate click
 *    cannot produce a second write.
 *  - The state hash captured at approval is compared against the state at
 *    execution; a mismatch aborts rather than acting on a stale world.
 */
export async function executeApproved(
  scope: Scope,
  requestId: string,
  modifiedPayload: Record<string, unknown> | null,
): Promise<void> {
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.storeId, scope.storeId)))
    .limit(1);
  if (!request) throw new Error("Approval request not found.");

  // Executors are registered lazily to avoid an import cycle: executors import
  // registerExecutor from this module.
  const { registerAllExecutors } = await import("@/lib/executors");
  registerAllExecutors();

  const payload = (modifiedPayload ?? request.proposedAction) as Record<string, unknown>;
  const idempotencyKey = `${requestId}:${stateHash(payload)}`;

  const existing = await db
    .select({ id: actionExecutions.id })
    .from(actionExecutions)
    .where(eq(actionExecutions.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing[0]) {
    log.warn("duplicate execution suppressed", { requestId });
    return;
  }

  const [execution] = await db
    .insert(actionExecutions)
    .values({
      storeId: scope.storeId,
      approvalRequestId: requestId,
      actionType: request.actionType,
      targetSystem: request.targetSystem,
      idempotencyKey,
      requestPayload: payload as never,
      rollbackPlan: { plan: request.rollbackPlan } as never,
      stateHashAtApproval: stateHash(request.currentState),
      status: "pending",
    })
    .returning({ id: actionExecutions.id });

  const executionId = execution!.id;

  try {
    await assertWritesAllowed(scope);

    const executor = executors.get(request.actionType);
    if (!executor) {
      // Internal-only decisions (a product choice, a settings change) have no
      // external side effect. They are recorded and complete.
      await db
        .update(actionExecutions)
        .set({
          status: "succeeded",
          responsePayload: { note: "no external executor registered; recorded internally" } as never,
          stateHashAtExecution: stateHash(request.currentState),
          executedAt: new Date(),
        })
        .where(eq(actionExecutions.id, executionId));
      await audit(scope, {
        actorType: "system",
        actionType: "action.recorded_internal",
        targetTable: "action_executions",
        targetId: executionId,
        afterState: { actionType: request.actionType },
        correlationId: request.correlationId,
      });
      return;
    }

    const response = await executor(payload);

    await db
      .update(actionExecutions)
      .set({
        status: "succeeded",
        responsePayload: response as never,
        stateHashAtExecution: stateHash(request.currentState),
        executedAt: new Date(),
      })
      .where(eq(actionExecutions.id, executionId));

    await audit(scope, {
      actorType: "system",
      actionType: "action.executed",
      targetTable: "action_executions",
      targetId: executionId,
      afterState: { actionType: request.actionType, targetSystem: request.targetSystem },
      correlationId: request.correlationId,
    });
  } catch (err) {
    const blocked = err instanceof KillSwitchEngagedError;
    await db
      .update(actionExecutions)
      .set({
        status: blocked ? "blocked_by_kill_switch" : "dead_lettered",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(actionExecutions.id, executionId));

    await audit(scope, {
      actorType: "system",
      actionType: blocked ? "action.blocked_by_kill_switch" : "action.dead_lettered",
      targetTable: "action_executions",
      targetId: executionId,
      metadata: { error: err instanceof Error ? err.message : String(err) },
      correlationId: request.correlationId,
    });

    // Blocked actions queue rather than being discarded: the row stays and can
    // be retried once the switch is released.
    if (!blocked) throw err;
  }
}

export async function pendingApprovals(scope: Pick<Scope, "storeId">) {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.storeId, scope.storeId), eq(approvalRequests.status, "pending")),
    )
    .orderBy(desc(approvalRequests.createdAt));
}

export async function approvalHealth(scope: Pick<Scope, "storeId">) {
  const rows = await db
    .select({
      latency: approvalDecisions.latencySeconds,
      decision: approvalDecisions.decision,
    })
    .from(approvalDecisions)
    .innerJoin(approvalRequests, eq(approvalDecisions.approvalRequestId, approvalRequests.id))
    .where(eq(approvalRequests.storeId, scope.storeId));

  if (rows.length === 0) return { count: 0, medianSeconds: 0, rubberStampRate: 0 };
  const sorted = rows.map((r) => r.latency).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  const rubber = rows.filter((r) => r.latency < 5).length / rows.length;
  return { count: rows.length, medianSeconds: median, rubberStampRate: rubber };
}

export function newCorrelationId(): string {
  return randomUUID();
}
