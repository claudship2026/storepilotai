import "server-only";
import { audit } from "@/lib/audit";
import { getSetting, setSetting } from "@/lib/settings";
import type { Scope } from "@/lib/db/scoped";

export class KillSwitchEngagedError extends Error {
  constructor(reason: string) {
    super(
      `Kill switch is engaged${reason ? `: ${reason}` : ""}. All external writes and agent ` +
        `invocations are blocked. Monitoring, dashboards and deterministic scoring continue.`,
    );
  }
}

export async function isKillSwitchOn(scope: Pick<Scope, "storeId">): Promise<boolean> {
  return (await getSetting(scope, "kill_switch")).enabled;
}

export async function killSwitchState(scope: Pick<Scope, "storeId">) {
  return getSetting(scope, "kill_switch");
}

/**
 * Call at the top of every code path that writes to an external system or
 * invokes an agent. Reads a single indexed row, so it is cheap enough to check
 * immediately before execution rather than once at the start of a workflow -
 * which is what makes the 5-second guarantee real.
 */
export async function assertWritesAllowed(scope: Pick<Scope, "storeId">): Promise<void> {
  const state = await getSetting(scope, "kill_switch");
  if (state.enabled) throw new KillSwitchEngagedError(state.reason);
}

export async function setKillSwitch(
  scope: Scope,
  enabled: boolean,
  reason: string,
): Promise<void> {
  await setSetting(scope, "kill_switch", {
    enabled,
    reason,
    engagedAt: enabled ? new Date().toISOString() : null,
  });
  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: enabled ? "kill_switch.engaged" : "kill_switch.released",
    targetTable: "settings",
    targetId: "kill_switch",
    afterState: { enabled, reason },
  });
}
