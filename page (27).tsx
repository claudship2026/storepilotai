import { needsPasswordSetup } from "@/lib/auth/credential";
import { env } from "@/lib/env";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const needsSetup = await needsPasswordSetup().catch(() => false);
  return <LoginForm needsSetup={needsSetup} adminEmail={env().ADMIN_EMAIL} />;
}
