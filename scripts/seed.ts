/**
 * Creates the single store row, applies the insert-only grant on audit_logs,
 * and writes default settings. Safe to run repeatedly.
 *
 *   npm run seed
 */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { stores, settings } from "../src/lib/db/schema";
import { SETTING_DEFAULTS } from "../src/lib/settings.schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");

  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client, { schema });

  // 1. Store row
  const existing = await db.select().from(stores).limit(1);
  const store =
    existing[0] ??
    (
      await db
        .insert(stores)
        .values({
          name: "StorePilot Store",
          currency: "USD",
          timezone: "America/Los_Angeles",
          targetCountry: "US",
        })
        .returning()
    )[0]!;
  console.log(`store: ${store.id}`);

  await db.execute(sql`set client_min_messages to warning;`);

  // 2. Audit log is insert-only at the database level, not by convention.
  //    A trigger works on every managed Postgres provider; role GRANTs do not.
  await db.execute(sql`
    create or replace function storepilot_block_audit_mutation()
    returns trigger as $$
    begin
      raise exception 'audit_logs is insert-only';
    end;
    $$ language plpgsql;
  `);
  await db.execute(sql`drop trigger if exists audit_logs_immutable on audit_logs;`);
  await db.execute(sql`
    create trigger audit_logs_immutable
    before update or delete on audit_logs
    for each row execute function storepilot_block_audit_mutation();
  `);
  console.log("audit_logs: insert-only trigger installed");

  // 3. Default settings
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db
      .insert(settings)
      .values({ storeId: store.id, key, value: value as never })
      .onConflictDoNothing({ target: [settings.storeId, settings.key] });
  }
  console.log(`settings: ${Object.keys(SETTING_DEFAULTS).length} defaults ensured`);

  await client.end();
  console.log("\nSeed complete. Start the app with: npm run dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
