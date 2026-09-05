import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings, stores } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { hashPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";

/**
 * The operator password.
 *
 * Two sources, in order: the ADMIN_PASSWORD_HASH environment variable, or a
 * bcrypt hash stored in settings and written once through the first-run screen.
 * The second exists so the application can be deployed without a terminal.
 *
 * Only the hash is ever stored. The plaintext is never written anywhere,
 * including logs, and the setup route can only be used while no hash exists.
 */

async function storedHash(): Promise<{ storeId: string; hash: string } | null> {
  const [store] = await db.select().from(stores).limit(1);
  if (!store) return null;

  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.storeId, store.id), eq(settings.key, "admin_credential")))
    .limit(1);

  const value = rows[0]?.value as { hash?: string } | undefined;
  return { storeId: store.id, hash: value?.hash ?? "" };
}

export async function resolveAdminHash(): Promise<string> {
  const fromEnv = env().ADMIN_PASSWORD_HASH;
  if (fromEnv) return fromEnv;
  return (await storedHash())?.hash ?? "";
}

export async function needsPasswordSetup(): Promise<boolean> {
  return (await resolveAdminHash()) === "";
}

export class PasswordAlreadySetError extends Error {}

export async function setInitialPassword(password: string): Promise<void> {
  const current = await storedHash();
  if (!current) throw new Error("No store row. Run the database setup SQL first.");
  if (env().ADMIN_PASSWORD_HASH || current.hash) {
    // Closed once set: this route can never be used to reset a live password.
    throw new PasswordAlreadySetError("A password is already set. Use the environment variable to change it.");
  }

  const hash = await hashPassword(password);
  await db
    .insert(settings)
    .values({
      storeId: current.storeId,
      key: "admin_credential",
      value: { hash, setAt: new Date().toISOString() } as never,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [settings.storeId, settings.key],
      set: { value: { hash, setAt: new Date().toISOString() } as never, updatedAt: new Date() },
    });

  await audit(
    { storeId: current.storeId },
    {
      actorType: "system",
      actionType: "auth.password_set",
      targetTable: "settings",
      targetId: "admin_credential",
      // The hash itself is deliberately not recorded in the audit trail.
      afterState: { set: true },
    },
  );
}
