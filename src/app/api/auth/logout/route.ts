import { NextResponse } from "next/server";
import { destroySession, getSession } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

export async function POST() {
  const session = await getSession();
  if (session) {
    await audit(
      { storeId: session.storeId },
      { actorType: "user", actorId: session.userId, actionType: "auth.logout" },
    );
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
