import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, stores } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { Scope } from "@/lib/db/scoped";

const COOKIE = "storepilot_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

function key() {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

export type SessionPayload = {
  userId: string;
  storeId: string;
  email: string;
  role: Scope["role"];
};

export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key());

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return {
      userId: String(payload.userId),
      storeId: String(payload.storeId),
      email: String(payload.email),
      role: payload.role as Scope["role"],
    };
  } catch {
    return null;
  }
}

/** Use in every server component and server action behind the app shell. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireScope(): Promise<Scope> {
  const s = await requireSession();
  return { storeId: s.storeId, userId: s.userId, role: s.role };
}

/** Resolves the single operator account, creating it on first successful login. */
export async function resolveAdminUser(email: string): Promise<SessionPayload | null> {
  if (email.toLowerCase() !== env().ADMIN_EMAIL.toLowerCase()) return null;

  const [store] = await db.select().from(stores).limit(1);
  if (!store) throw new Error("No store row found. Run `npm run seed` first.");

  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user =
    existing[0] ??
    (
      await db
        .insert(users)
        .values({ storeId: store.id, email, name: "Operator", role: "founder" })
        .returning()
    )[0]!;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  return { userId: user.id, storeId: store.id, email: user.email, role: user.role };
}
