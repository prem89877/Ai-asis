import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEncryptionConfigured } from "@/lib/integrations/crypto";
import { googleAuthUrl } from "@/lib/integrations/google";
import { microsoftAuthUrl } from "@/lib/integrations/microsoft";
import { DEFAULT_ZOHO_REGION, isZohoRegion, ZOHO_BOOKS_SCOPES, ZOHO_SHEET_SCOPES, zohoAuthUrl } from "@/lib/integrations/zoho";
import { readJsonBody } from "@/lib/api/body";
import { newCodeVerifier, newState } from "@/lib/integrations/oauth";
import { isOAuthProvider, isZohoProvider, providerConfigs, saveState } from "@/lib/integrations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts the sign-in on Google's / Microsoft's own page. The user's cloud password is never seen by AI Asis.
export async function POST(request: Request, { params }: { params: { provider: string } }) {
  if (!isOAuthProvider(params.provider)) return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  if (g.membership.role !== "owner" && g.membership.role !== "admin") return json({ error: "Only a firm owner or admin can connect an account." }, 403);
  const cfg = providerConfigs();
  const conf = params.provider === "google_sheets" ? cfg.google : params.provider === "microsoft_excel" ? cfg.microsoft : params.provider === "zoho_sheet" ? cfg.zohoSheet : cfg.zohoBooks;
  const admin = createAdminClient();
  if (!conf || !admin || !isEncryptionConfigured()) return json({ error: "This integration is not configured on the server yet." }, 503);

  // Zoho keeps each account in one data centre; the user picks it on the Connect screen (default India).
  let region = null as string | null;
  if (isZohoProvider(params.provider)) {
    const body = await readJsonBody(request, 1024);
    const r = body.ok ? (body.value as { region?: unknown } | null)?.region : undefined;
    if (r !== undefined && !isZohoRegion(r)) return json({ error: "Choose a valid Zoho data centre." }, 400);
    region = isZohoRegion(r) ? r : DEFAULT_ZOHO_REGION;
  }
  const state = newState();
  const verifier = newCodeVerifier();
  const saved = await saveState(admin, { state, firmId: g.membership.firmId, userId: g.user.id, provider: params.provider, verifier, region });
  if (!saved) return json({ error: "The connection could not be started. Try again." }, 500);
  const url = params.provider === "google_sheets" ? googleAuthUrl(cfg.google!, state, verifier)
    : params.provider === "microsoft_excel" ? microsoftAuthUrl(cfg.microsoft!, state, verifier)
    : zohoAuthUrl((params.provider === "zoho_sheet" ? cfg.zohoSheet : cfg.zohoBooks)!, params.provider === "zoho_sheet" ? ZOHO_SHEET_SCOPES : ZOHO_BOOKS_SCOPES, isZohoRegion(region) ? region : DEFAULT_ZOHO_REGION, state);
  return json({ url });
}
