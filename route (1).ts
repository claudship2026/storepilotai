import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import { resolveAdminHash } from "@/lib/auth/credential";
import { createSession, resolveAdminUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { log } from "@/lib/logger";

const body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const limit = rateLimit(`login:${ip}`, { capacity: 5, refillPerSecond: 0.1 });
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  }

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const hash = await resolveAdminHash();
  if (!hash) {
    return NextResponse.json(
      { error: "No password is set yet for this deployment.", needsSetup: true },
      { status: 409 },
    );
  }

  const ok = await verifyPassword(parsed.data.password, hash);
  const user = ok ? await resolveAdminUser(parsed.data.email) : null;

  if (!user) {
    log.warn("failed login", { email: parsed.data.email });
    // Same message and shape for a bad email and a bad password.
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  await createSession(user);
  await audit(
    { storeId: user.storeId },
    { actorType: "user", actorId: user.userId, actionType: "auth.login" },
  );

  return NextResponse.json({ ok: true });
}
