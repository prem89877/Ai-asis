"use server";

import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/env";
import { safeNextPath } from "@/lib/security/redirect";

export interface ActionResult {
  ok: boolean;
  message: string;
  redirectTo?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8 && password.length <= 72;
}

// Logs only error codes, never emails, passwords or tokens.
function logAuthError(event: string, error: { code?: string; status?: number }) {
  console.error(event, { code: error.code ?? null, status: error.status ?? null });
}

export async function signUpAction(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ActionResult> {
  const name = text(input?.name, 120);
  const email = text(input?.email, 254).toLowerCase();
  const password = input?.password;
  if (!name) return { ok: false, message: "Enter your name." };
  if (!EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (!validPassword(password)) return { ok: false, message: "Use 8 to 72 characters for your password." };

  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name },
      emailRedirectTo: `${getSiteUrl()}/auth/callback?next=/dashboard`,
    },
  });
  if (error) {
    logAuthError("auth_signup_failed", error);
    return { ok: false, message: "We couldn't create the account. Check your details and try again." };
  }
  if (data.session) return { ok: true, message: "Account created.", redirectTo: "/dashboard" };
  return { ok: true, message: "Check your email to confirm your account, then log in." };
}

export async function signInAction(input: {
  email: string;
  password: string;
  next?: string;
}): Promise<ActionResult> {
  const email = text(input?.email, 254).toLowerCase();
  const password = input?.password;
  if (!EMAIL_RE.test(email) || !validPassword(password)) {
    return { ok: false, message: "Invalid email or password." };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    logAuthError("auth_signin_failed", error);
    if (error.code === "email_not_confirmed") {
      return { ok: false, message: "Confirm your email first. Check your inbox for the link." };
    }
    return { ok: false, message: "Invalid email or password." };
  }
  return { ok: true, message: "Logged in.", redirectTo: safeNextPath(input.next) };
}

export async function signOutAction(): Promise<void> {
  const supabase = createClient();
  await supabase.auth.signOut();
}

// Always returns the same message so the form cannot be used to discover registered emails.
export async function requestPasswordResetAction(input: { email: string }): Promise<ActionResult> {
  const email = text(input?.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email address." };

  const supabase = createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${getSiteUrl()}/auth/callback?next=/reset-password`,
  });
  if (error) logAuthError("auth_reset_request_failed", error);
  return { ok: true, message: "If an account exists for that email, a reset link is on its way." };
}

export async function updatePasswordAction(input: { password: string }): Promise<ActionResult> {
  if (!validPassword(input?.password)) {
    return { ok: false, message: "Use 8 to 72 characters for your password." };
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Your reset link has expired. Request a new one." };

  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) {
    logAuthError("auth_update_password_failed", error);
    return { ok: false, message: "We couldn't update the password. Try again." };
  }
  return { ok: true, message: "Password updated.", redirectTo: "/dashboard" };
}
