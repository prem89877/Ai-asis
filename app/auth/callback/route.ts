import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/security/redirect";

// Handles email confirmation, password recovery and Google OAuth redirects (PKCE code exchange).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    console.error("auth_callback_failed", { code: error.code ?? null });
  }
  return NextResponse.redirect(new URL("/login?error=auth_callback", origin));
}
