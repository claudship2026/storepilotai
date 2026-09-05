"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireScope } from "@/lib/auth/session";
import { decide, propose, type Decision } from "@/lib/approvals";

const decideInput = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approved", "modified", "rejected", "info_requested"]),
  note: z.string().max(2000).optional(),
  modifiedPayload: z.string().optional(),
});

export async function decideAction(formData: FormData) {
  const scope = await requireScope();
  const parsed = decideInput.parse({
    requestId: formData.get("requestId"),
    decision: formData.get("decision"),
    note: (formData.get("note") as string) || undefined,
    modifiedPayload: (formData.get("modifiedPayload") as string) || undefined,
  });

  let modified: Record<string, unknown> | undefined;
  if (parsed.decision === "modified" && parsed.modifiedPayload) {
    try {
      modified = JSON.parse(parsed.modifiedPayload) as Record<string, unknown>;
    } catch {
      throw new Error("Modified payload is not valid JSON. The action was not executed.");
    }
  }

  await decide(scope, parsed.requestId, parsed.decision as Decision, {
    note: parsed.note,
    modifiedPayload: modified,
  });

  revalidatePath("/approvals");
  revalidatePath("/dashboard");
}

/**
 * Creates a harmless internal approval request so the queue, the executor, the
 * kill switch and the audit chain can be exercised end to end before any real
 * integration exists.
 */
export async function createTestApproval() {
  const scope = await requireScope();
  await propose(scope, {
    actionType: "test.noop",
    targetSystem: "internal",
    summary: "Test approval: verifies the queue, executor, audit chain and kill switch.",
    proposedAction: { note: "No external system is touched by this action.", value: 1 },
    currentState: { note: "No external system is touched by this action.", value: 0 },
    evidence: [
      {
        label: "Purpose",
        detail:
          "Phase 1 acceptance test. Approving writes an action_executions row and two audit rows.",
      },
    ],
    confidence: 1,
    riskLevel: "low",
    financialImpactMinCents: 0,
    financialImpactMaxCents: 0,
    rollbackPlan: "None needed. This action has no external effect.",
    recommendedDecision: "Approve to confirm the pipeline works, or reject to confirm it stops.",
    alternatives: [{ label: "Reject", detail: "Records a rejection and executes nothing." }],
  });
  revalidatePath("/approvals");
}
