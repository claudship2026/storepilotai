import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createSession, resolveAdminUser } from "@/lib/auth/session";
import { needsPasswordSetup, setInitialPassword, PasswordAlreadySetError } from "@/lib/auth/credential";
import { rateLimit } from "@/lib/ratelimit";
import { log } from "@/lib/logger";

const body = z.object({
  email: z.string().email(),
  password: z.string().min(12, "Use at least 12 characters."),
});

/**
 * First-run password setup, so the app can be deployed without a terminal.
 *
 * Three things keep this from being an open door:
 *   1. It only works while no password exists anywhere. Once set, it is closed
 *      permanently and returns 409.
 *   2. The email must match ADMIN_EMAIL, which is set in the environment before
 *      the app ever boots.
 *   3. It is rate limited like the login route.
 */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const limit = rateLimit(`setup:${ip}`, { capacity: 5, refillPerSecond: 0.05 });
  if (!limit.ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  if (!(await needsPasswordSetup())) {
    return NextResponse.json({ error: "A password is already set." }, { status: 409 });
  }

  if (parsed.data.email.toLowerCase() !== env().ADMIN_EMAIL.toLowerCase()) {
    log.warn("setup attempted with a non-matching email", { email: parsed.data.email });
    return NextResponse.json(
      { error: "That email does not match ADMIN_EMAIL for this deployment." },
      { status: 401 },
    );
  }

  try {
    await setInitialPassword(parsed.data.password);
  } catch (err) {
    if (err instanceof PasswordAlreadySetError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  const user = await resolveAdminUser(parsed.data.email);
  if (!user) return NextResponse.json({ error: "Could not create the operator account." }, { status: 500 });
  await createSession(user);

  return NextResponse.json({ ok: true });
}
