"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn, Badge } from "@/components/ui";

const MAIN = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/research", label: "1 · Research" },
  { href: "/suppliers", label: "2 · Product & Supplier" },
  { href: "/store-builder", label: "3 · Store Builder" },
  { href: "/creative", label: "4 · Creative Studio" },
  { href: "/command-center", label: "5 · Command Center" },
];

const GOVERNANCE = [
  { href: "/stack", label: "Store stack" },
  { href: "/approvals", label: "Approval queue" },
  { href: "/audit", label: "Audit log" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ email, pendingCount }: { email: string; pendingCount: number }) {
  const pathname = usePathname();
  const router = useRouter();

  const item = (href: string, label: string, badge?: number) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        className={cn(
          "flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
          active ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
        )}
      >
        <span>{label}</span>
        {badge ? <Badge tone="warn">{badge}</Badge> : null}
      </Link>
    );
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 px-5 py-4">
        <p className="text-sm font-semibold tracking-tight">StorePilot AI</p>
        <p className="mt-0.5 text-[11px] text-ink-400">Human-governed store ops</p>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto p-3">
        <div className="space-y-0.5">{MAIN.map((i) => item(i.href, i.label))}</div>
        <div>
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Governance
          </p>
          <div className="space-y-0.5">
            {GOVERNANCE.map((i) =>
              item(i.href, i.label, i.href === "/approvals" ? pendingCount : undefined),
            )}
          </div>
        </div>
      </nav>

      <div className="border-t border-ink-700 p-3">
        <p className="truncate px-2 pb-2 text-[11px] text-ink-400">{email}</p>
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.push("/login");
            router.refresh();
          }}
          className="w-full rounded-md px-3 py-1.5 text-left text-xs text-ink-300 hover:bg-ink-850 hover:text-ink-100"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
