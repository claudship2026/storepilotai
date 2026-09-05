import "server-only";
import { getSetting } from "@/lib/settings";
import type { Scope } from "@/lib/db/scoped";

export type FlagName =
  | "research"
  | "suppliers"
  | "storeBuilder"
  | "creativeStudio"
  | "commandCenter"
  | "shopifyWrites";

/** Phase gating. A tab is visible but inert until its flag is turned on. */
export async function flags(scope: Pick<Scope, "storeId">) {
  return getSetting(scope, "feature_flags");
}

export async function isEnabled(scope: Pick<Scope, "storeId">, flag: FlagName): Promise<boolean> {
  return (await flags(scope))[flag];
}
