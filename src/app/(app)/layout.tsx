import { requireSession } from "@/lib/auth/session";
import { killSwitchState } from "@/lib/killswitch";
import { pendingApprovals } from "@/lib/approvals";
import { Nav } from "@/components/nav";
import { KillSwitchBanner } from "@/components/kill-switch-banner";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const scope = { storeId: session.storeId };
  const [ks, pending] = await Promise.all([killSwitchState(scope), pendingApprovals(scope)]);

  return (
    <div className="flex min-h-screen">
      <Nav email={session.email} pendingCount={pending.length} />
      <div className="flex min-w-0 flex-1 flex-col">
        {ks.enabled ? <KillSwitchBanner reason={ks.reason} /> : null}
        <main className="flex-1 px-8 py-7">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
