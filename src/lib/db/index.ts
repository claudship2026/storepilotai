import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __storepilot_sql: ReturnType<typeof postgres> | undefined;
}

const client =
  globalThis.__storepilot_sql ??
  postgres(env().DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    prepare: false,
  });

if (env().NODE_ENV !== "production") globalThis.__storepilot_sql = client;

export const db = drizzle(client, { schema });
export { schema };
export type Db = typeof db;
