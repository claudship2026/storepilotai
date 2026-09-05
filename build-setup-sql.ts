/**
 * Produces supabase-setup.sql: everything the database needs, in one file you
 * can paste into the Supabase SQL editor.
 *
 *   npx tsx scripts/build-setup-sql.ts
 *
 * Generated from the Drizzle migration plus SETTING_DEFAULTS, so it cannot
 * drift from the schema the application expects.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SETTING_DEFAULTS } from "../src/lib/settings.schema";

const dir = join(process.cwd(), "drizzle");
const migration = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

// Drizzle emits --> statement-breakpoint markers; Postgres does not want them.
// The rest of these rewrites make the DDL re-runnable, so pasting the file a
// second time is a no-op rather than a wall of "already exists" errors.
const ddl = migration
  .replace(/-->\s*statement-breakpoint/g, "")
  .replace(/^CREATE TYPE (.+?);$/gm, (_m, body: string) =>
    `do $do$ begin\n  CREATE TYPE ${body};\nexception when duplicate_object then null; end $do$;`,
  )
  .replace(/^CREATE TABLE "/gm, 'CREATE TABLE IF NOT EXISTS "')
  .replace(/^CREATE INDEX "/gm, 'CREATE INDEX IF NOT EXISTS "')
  .replace(/^CREATE UNIQUE INDEX "/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
  .replace(/^ALTER TABLE (.+?);$/gm, (_m, body: string) =>
    `do $do$ begin\n  ALTER TABLE ${body};\nexception when duplicate_object then null; end $do$;`,
  );

const settingsInserts = Object.entries(SETTING_DEFAULTS)
  .map(
    ([key, value]) =>
      `  insert into settings (store_id, key, value)\n` +
      `  values (v_store, '${key}', '${JSON.stringify(value).replace(/'/g, "''")}'::jsonb)\n` +
      `  on conflict (store_id, key) do nothing;`,
  )
  .join("\n\n");

const sql = `--
-- StorePilot AI · complete database setup
--
-- Paste this whole file into the Supabase SQL editor and press Run.
-- Safe to run more than once: every statement is guarded.
--
-- It does three things:
--   1. Creates the schema (34 tables, enums, indexes).
--   2. Makes audit_logs insert-only at the database level, so history cannot be
--      rewritten by the application or by anything that compromises it.
--   3. Creates your single store row and the default settings.
--

begin;

-- ============================================================
-- 1. Schema
-- ============================================================

${ddl}

-- ============================================================
-- 2. Audit log immutability
-- ============================================================

create or replace function storepilot_block_audit_mutation()
returns trigger as $fn$
begin
  raise exception 'audit_logs is insert-only';
end;
$fn$ language plpgsql;

drop trigger if exists audit_logs_immutable on audit_logs;

create trigger audit_logs_immutable
before update or delete on audit_logs
for each row execute function storepilot_block_audit_mutation();

-- ============================================================
-- 3. Store row and default settings
-- ============================================================

do $seed$
declare
  v_store uuid;
begin
  select id into v_store from stores limit 1;

  if v_store is null then
    insert into stores (name, currency, timezone, target_country)
    values ('StorePilot Store', 'USD', 'America/Los_Angeles', 'US')
    returning id into v_store;
  end if;

${settingsInserts}
end
$seed$;

commit;

-- ============================================================
-- Done. Expected result: "Success. No rows returned".
--
-- Sanity check, optional:
--   select count(*) from information_schema.tables where table_schema = 'public';
--   -- should be 34
--   select key from settings order by key;
--   -- should list ai_budget, business_defaults, feature_flags, kill_switch, supplier_weights
-- ============================================================
`;

writeFileSync(join(process.cwd(), "supabase-setup.sql"), sql);
console.log(`Wrote supabase-setup.sql (${(sql.length / 1024).toFixed(1)} KB)`);
