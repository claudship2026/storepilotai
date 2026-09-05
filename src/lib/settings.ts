import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { Scope } from "@/lib/db/scoped";
import {
  SETTINGS_SCHEMA,
  SETTING_DEFAULTS,
  type SettingKey,
  type SettingValue,
} from "@/lib/settings.schema";

export { SETTINGS_SCHEMA, SETTING_DEFAULTS };
export type { SettingKey, SettingValue };

/* ------------------------------------------------------------------ */

export async function getSetting<K extends SettingKey>(
  scope: Pick<Scope, "storeId">,
  key: K,
): Promise<SettingValue<K>> {
  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.storeId, scope.storeId), eq(settings.key, key)))
    .limit(1);

  if (!rows[0]) return SETTING_DEFAULTS[key];
  const parsed = SETTINGS_SCHEMA[key].safeParse(rows[0].value);
  return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(
  scope: Scope,
  key: K,
  value: SettingValue<K>,
): Promise<void> {
  const validated = SETTINGS_SCHEMA[key].parse(value);
  const before = await getSetting(scope, key);

  await db
    .insert(settings)
    .values({
      storeId: scope.storeId,
      key,
      value: validated as never,
      updatedBy: scope.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [settings.storeId, settings.key],
      set: { value: validated as never, updatedBy: scope.userId, updatedAt: new Date() },
    });

  await audit(scope, {
    actorType: "user",
    actorId: scope.userId,
    actionType: `settings.${key}.updated`,
    targetTable: "settings",
    targetId: key,
    beforeState: before,
    afterState: validated,
  });
}

export async function getAllSettings(scope: Pick<Scope, "storeId">) {
  const keys = Object.keys(SETTINGS_SCHEMA) as SettingKey[];
  const entries = await Promise.all(keys.map(async (k) => [k, await getSetting(scope, k)] as const));
  return Object.fromEntries(entries) as { [K in SettingKey]: SettingValue<K> };
}
