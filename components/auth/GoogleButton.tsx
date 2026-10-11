"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";

// Shown only when NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true (after Google is configured in Supabase).
export function GoogleButton({ next }: { next: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED !== "true") return null;

  async function signIn() {
    setLoading(true);
    setError(null);
    const { error: oauthError } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (oauthError) {
      setError("Google sign-in is not available right now.");
      setLoading(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="relative my-4 text-center text-xs text-ink-muted">
        <span className="bg-white px-2">or</span>
      </div>
      <Button type="button" variant="secondary" size="lg" className="w-full" loading={loading} onClick={signIn}>
        Continue with Google
      </Button>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
