"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Field, Input } from "@/components/ui";

export function LoginForm({ needsSetup, adminEmail }: { needsSetup: boolean; adminEmail: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(needsSetup ? adminEmail : "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (needsSetup && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (needsSetup && password.length < 12) {
      setError("Use at least 12 characters.");
      return;
    }

    setBusy(true);
    const res = await fetch(needsSetup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">StorePilot AI</h1>
          <p className="mt-1 text-xs text-ink-400">
            {needsSetup ? "First run: choose your password" : "Operator access only"}
          </p>
        </div>

        <Card>
          <CardBody>
            {needsSetup ? (
              <p className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-ink-100">
                No password is set for this deployment yet. Set one now: this screen closes
                permanently once you do, and the password is stored only as a bcrypt hash.
              </p>
            ) : null}

            <form onSubmit={submit} className="space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={needsSetup}
                  required
                />
              </Field>

              <Field
                label={needsSetup ? "Choose a password" : "Password"}
                hint={needsSetup ? "At least 12 characters." : undefined}
              >
                <Input
                  type="password"
                  autoComplete={needsSetup ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>

              {needsSetup ? (
                <Field label="Confirm password">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </Field>
              ) : null}

              {error ? <p className="text-xs text-bad">{error}</p> : null}

              <Button type="submit" variant="primary" className="w-full" disabled={busy}>
                {busy ? "Working…" : needsSetup ? "Set password and continue" : "Sign in"}
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
