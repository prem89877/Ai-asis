"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { AuthCard, authInputClass } from "@/components/auth/AuthCard";
import { requestPasswordResetAction, updatePasswordAction } from "@/lib/auth/actions";

function Notice({ ok, message }: { ok: boolean; message: string }) {
  return (
    <p className={ok ? "rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink" : "rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"}>
      {message}
    </p>
  );
}

export function ForgotPasswordForm() {
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    setLoading(true);
    try {
      setNotice(await requestPasswordResetAction({ email }));
    } catch {
      setNotice({ ok: false, message: "Something went wrong. Please try again." });
    }
    setLoading(false);
  }

  return (
    <AuthCard title="Reset your password" subtitle="Enter your email and we'll send a reset link.">
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required className={authInputClass} />
        </div>
        <Button type="submit" size="lg" loading={loading} className="w-full">Send reset link</Button>
        <div role="status" aria-live="polite">{notice && <Notice {...notice} />}</div>
      </form>
      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/login" className="font-semibold text-brand underline">Back to log in</Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    if (password.length < 8) {
      setNotice({ ok: false, message: "Use at least 8 characters." });
      return;
    }
    setLoading(true);
    try {
      const result = await updatePasswordAction({ password });
      setNotice({ ok: result.ok, message: result.message });
      if (result.ok && result.redirectTo) {
        router.replace(result.redirectTo);
        router.refresh();
        return;
      }
    } catch {
      setNotice({ ok: false, message: "Something went wrong. Please try again." });
    }
    setLoading(false);
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <div>
          <label htmlFor="password" className="text-sm font-medium">New password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" className={authInputClass} />
        </div>
        <Button type="submit" size="lg" loading={loading} className="w-full">Update password</Button>
        <div role="status" aria-live="polite">{notice && <Notice {...notice} />}</div>
      </form>
    </AuthCard>
  );
}
