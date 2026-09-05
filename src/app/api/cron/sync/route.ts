import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { stores } from "@/lib/db/schema";
import { syncFromShopify, rebuildDailyMetrics } from "@/lib/metrics";
import { runDetection } from "@/lib/detect";
import { isKillSwitchOn } from "@/lib/killswitch";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled sync. Point Vercel Cron (or any scheduler) at this hourly with
 * `Authorization: Bearer <SESSION_SECRET>`.
 *
 * Detection runs here but the analyst does not: interpreting signals costs
 * tokens, so it stays a deliberate action rather than something that happens
 * hourly whether or not anything changed.
 */
export async function GET(req: Request) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Accept that when it
  // is configured, and fall back to SESSION_SECRET for any other scheduler.
  const auth = req.headers.get("authorization") ?? "";
  const accepted = [process.env.CRON_SECRET, env().SESSION_SECRET]
    .filter((s): s is string => Boolean(s))
    .map((s) => `Bearer ${s}`);

  const authorized = accepted.some((expected) => {
    const a = Buffer.from(auth);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!authorized) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [store] = await db.select().from(stores).limit(1);
  if (!store) return NextResponse.json({ error: "no store" }, { status: 500 });
  const scope = { storeId: store.id };

  // Detection and metrics keep running with the kill switch engaged. Stopping
  // the AI must never mean going blind.
  const killed = await isKillSwitchOn(scope);

  try {
    const synced = await syncFromShopify(scope, 30);
    const days = await rebuildDailyMetrics(scope, 60);
    const signals = await runDetection(scope, 14);

    return NextResponse.json({
      ok: true,
      killSwitch: killed,
      synced,
      metricDays: days,
      signals: signals.length,
    });
  } catch (err) {
    log.error("cron sync failed", { error: (err as Error).message });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
