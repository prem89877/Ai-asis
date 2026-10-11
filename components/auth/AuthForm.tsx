"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { signInAction, signUpAction } from "@/lib/auth/actions";
import type { AuthMode } from "@/lib/auth";

interface Errors {
  name?: string;
  email?: string;
  password?: string;
}

interface AuthFormProps {
  mode: AuthMode;
  next?: string;
  callbackError?: boolean;
}

const inputClass =
  "mt-1.5 block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base placeholder:text-slate-400 aria-[invalid=true]:border-red-600";

export function AuthForm({ mode, next = "/dashboard", callbackError = false }: AuthFormProps) {
  const router = useRouter();
  const isRegister = mode === "register";
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(
    callbackError ? { ok: false, message: "That link is invalid or has expired. Please try again." } : null
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");

    // These checks are only for quick feedback. The server action validates everything again.
    const nextErrors: Errors = {};
    if (isRegister && !name) nextErrors.name = "Enter your name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) nextErrors.email = "Enter a valid email address.";
    if (password.length < 8) nextErrors.password = "Use at least 8 characters.";
    setErrors(nextErrors);
    setNotice(null);
    if (Object.keys(nextErrors).length > 0) return;

    setLoading(true);
    try {
      const result = isRegister
        ? await signUpAction({ name, email, password })
        : await signInAction({ email, password, next });
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
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight">
            {isRegister ? "Create your account" : "Log in to AI Asis"}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {isRegister ? "Start free. Invoice extraction is not live yet." : "Welcome back."}
          </p>

          <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
            {isRegister && (
              <div>
                <label htmlFor="name" className="text-sm font-medium">Full name</label>
                <input id="name" name="name" type="text" autoComplete="name" className={inputClass} aria-invalid={!!errors.name} aria-describedby={errors.name ? "name-error" : undefined} />
                {errors.name && <p id="name-error" className="mt-1 text-sm text-red-700">{errors.name}</p>}
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-sm font-medium">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" className={inputClass} aria-invalid={!!errors.email} aria-describedby={errors.email ? "email-error" : undefined} />
              {errors.email && <p id="email-error" className="mt-1 text-sm text-red-700">{errors.email}</p>}
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-sm font-medium">Password</label>
                {!isRegister && (
                  <Link href="/forgot-password" className="text-sm font-medium text-brand underline">Forgot password?</Link>
                )}
              </div>
              <input id="password" name="password" type="password" autoComplete={isRegister ? "new-password" : "current-password"} className={inputClass} aria-invalid={!!errors.password} aria-describedby={errors.password ? "password-error" : undefined} />
              {errors.password && <p id="password-error" className="mt-1 text-sm text-red-700">{errors.password}</p>}
            </div>

            <Button type="submit" size="lg" loading={loading} className="w-full">
              {loading ? "Please wait" : isRegister ? "Create account" : "Log in"}
            </Button>

            <div role="status" aria-live="polite">
              {notice && (
                <p className={notice.ok ? "rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink" : "rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"}>
                  {notice.message}
                </p>
              )}
            </div>
          </form>

          <GoogleButton next={next} />
        </div>
        <p className="mt-6 text-center text-sm text-ink-muted">
          {isRegister ? "Already have an account? " : "New to AI Asis? "}
          <Link href={isRegister ? "/login" : "/register"} className="font-semibold text-brand underline">
            {isRegister ? "Log in" : "Create an account"}
          </Link>
        </p>
      </div>
    </main>
  );
}
