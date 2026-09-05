import { and, eq, type SQL } from "drizzle-orm";
import { db } from "./index";

/**
 * Every read and write goes through a store-scoped accessor. A route handler
 * that forgets its own check still cannot reach another store's rows, because
 * the scope predicate is added here rather than at the call site.
 *
 * Only one store exists today. This exists so multi-store is additive later,
 * not a rewrite, and so the isolation test in Phase 1 is meaningful.
 */
export type Scope = {
  storeId: string;
  userId: string;
  role: "founder" | "ops" | "support" | "finance" | "analyst";
};

// A table shape that carries a storeId column.
type ScopedTable = { storeId: unknown };

export function scoped(scope: Scope) {
  return {
    db,
    /** Combine a store predicate with any additional filters. */
    where<T extends ScopedTable>(table: T, ...filters: (SQL | undefined)[]): SQL {
      const base = eq(table.storeId as never, scope.storeId);
      const extra = filters.filter((f): f is SQL => Boolean(f));
      return extra.length > 0 ? (and(base, ...extra) as SQL) : base;
    },
    /** Stamp storeId onto any insert payload. */
    values<T extends Record<string, unknown>>(payload: T): T & { storeId: string } {
      return { ...payload, storeId: scope.storeId };
    },
    scope,
  };
}

export type ScopedDb = ReturnType<typeof scoped>;
