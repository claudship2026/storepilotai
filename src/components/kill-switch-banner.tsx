import Link from "next/link";

export function KillSwitchBanner({ reason }: { reason: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-bad/40 bg-bad/15 px-6 py-2.5">
      <p className="text-xs text-ink-100">
        <span className="font-semibold uppercase tracking-wide text-bad">Kill switch engaged</span>
        {" — all external writes and agent runs are blocked. Monitoring and dashboards keep running."}
        {reason ? <span className="text-ink-300"> Reason: {reason}</span> : null}
      </p>
      <Link
        href="/settings"
        className="shrink-0 rounded border border-bad/50 px-2 py-1 text-[11px] text-ink-100 hover:bg-bad/20"
      >
        Manage
      </Link>
    </div>
  );
}
