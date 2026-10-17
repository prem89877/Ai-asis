import { NextResponse } from "next/server";
import { getPrimaryMembership } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { googleExchangeCode } from "@/lib/integrations/google";
import { microsoftExchangeCode } from "@/lib/integrations/microsoft";
import { readIdTokenClaims } from "@/lib/integrations/oauth";
import { DEFAULT_ZOHO_REGION, isZohoRegion, zohoExchangeCode } from "@/lib/integrations/zoho";
import { consumeState, isOAuthProvider, isZohoProvider, providerConfigs, saveConnectionTokens } from "@/lib/integrations/store";
import { userMessage } from "@/lib/integrations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(params: Record<string, string>): NextResponse {
  const u = new URL("/dashboard/integrations", getSiteUrl());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u, { headers: { "Cache-Control": "no-store" } });
}

// OAuth redirect target. Security checks: the single-use state must exist, be unexpired, and belong to THIS signed-in user,
// provider and firm; the code is exchanged with the PKCE verifier stored server-side.
export async function GET(request: Request, { params }: { params: { provider: string } }) {
  if (!isOAuthProvider(params.provider)) return back({ error: "unknown_provider" });
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back({ error: "access_denied" }); // user pressed Cancel or the provider refused
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || code.length > 2048 || state.length > 128) return back({ error: "invalid_response" });

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return back({ error: "signed_out" });
  const membership = await getPrimaryMembership(supabase, user.id);
  const admin = createAdminClient();
  if (!membership || !admin) return back({ error: "not_configured" });

  const st = await consumeState(admin, state);
  if (!st || st.userId !== user.id || st.provider !== params.provider || st.firmId !== membership.firmId) return back({ error: "invalid_state" });
  if (membership.role !== "owner" && membership.role !== "admin") return back({ error: "forbidden" });

  try {
    const cfg = providerConfigs();
    const region = isZohoRegion(st.region) ? st.region : DEFAULT_ZOHO_REGION;
    const zc = params.provider === "zoho_sheet" ? cfg.zohoSheet : cfg.zohoBooks;
    if (isZohoProvider(params.provider) && !zc) return back({ error: "not_configured" });
    const tokens = params.provider === "google_sheets"
      ? await googleExchangeCode(cfg.google!, code, st.verifier)
      : params.provider === "microsoft_excel"
        ? await microsoftExchangeCode(cfg.microsoft!, code, st.verifier)
        : await zohoExchangeCode(zc!, region, code);
    if (!tokens.refreshToken) return back({ error: "no_refresh_token" });
    const ok = await saveConnectionTokens(admin, { firmId: st.firmId, userId: user.id, provider: params.provider, email: readIdTokenClaims(tokens.idToken).email, tokens, region: isZohoProvider(params.provider) ? region : null });
    return ok ? back({ connected: params.provider }) : back({ error: "save_failed" });
  } catch (e) {
    console.error("oauth_callback_failed", { provider: params.provider, code: userMessage(e).code });
    return back({ error: "exchange_failed" });
  }
}
