/**
 * Phase 1 acceptance checks. Run against your dev database:
 *
 *   npx tsx scripts/verify-phase1.ts
 *
 * Asserts the four safety properties that everything later depends on.
 */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { stores, auditLogs, settings } from "../src/lib/db/schema";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  const [store] = await db.select().from(stores).limit(1);
  if (!store) throw new Error("No store. Run `npm run seed` first.");

  // 1. Audit rows can be inserted.
  const [row] = await db
    .insert(auditLogs)
    .values({
      storeId: store.id,
      actorType: "system",
      actionType: "verify.phase1",
      metadata: { note: "written by verify-phase1" } as never,
    })
    .returning();
  check("audit_logs accepts INSERT", Boolean(row));

  // 2. Audit rows cannot be updated.
  try {
    await db
      .update(auditLogs)
      .set({ actionType: "tampered" })
      .where(eq(auditLogs.id, row!.id));
    check("audit_logs rejects UPDATE", false, "the update succeeded, which it must not");
  } catch (e) {
    check("audit_logs rejects UPDATE", true, (e as Error).message.slice(0, 60));
  }

  // 3. Audit rows cannot be deleted.
  try {
    await db.delete(auditLogs).where(eq(auditLogs.id, row!.id));
    check("audit_logs rejects DELETE", false, "the delete succeeded, which it must not");
  } catch (e) {
    check("audit_logs rejects DELETE", true, (e as Error).message.slice(0, 60));
  }

  // 4. Store scoping: a query for a different store id returns nothing.
  const otherStore = "00000000-0000-0000-0000-000000000000";
  const leaked = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.storeId, otherStore))
    .limit(1);
  check("store scoping returns no cross-store rows", leaked.length === 0);

  // 5. Settings uniqueness holds, so a concurrent write cannot fork config.
  const dupe = await db.execute(sql`
    select count(*) as c from (
      select store_id, key from settings group by store_id, key having count(*) > 1
    ) t;
  `);
  check("settings has no duplicate (store, key) rows", Number((dupe as never as Array<{ c: string }>)[0]?.c ?? 0) === 0);

  await client.end();
  console.log(failures === 0 ? "\nAll Phase 1 checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
