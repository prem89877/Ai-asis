import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEncryptionConfigured } from "@/lib/integrations/crypto";
import { googleAuthUrl } from "@/lib/integrations/google";
import { microsoftAuthUrl } from "@/lib/integrations/microsoft";
import { newCodeVerifier, newState } from "@/lib/integrations/oauth";
import { isProvider, providerConfigs, saveState } from "@/lib/integrations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts the sign-in on Google's / Microsoft's own page. The user's cloud password is never seen by AI Asis.
export async function POST(request: Request, { params }: { params: { provider: string } }) {
  if (!isProvider(params.provider)) return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  if (g.membership.role !== "owner" && g.membership.role !== "admin") return json({ error: "Only a firm owner or admin can connect an account." }, 403);
  const cfg = providerConfigs();
  const conf = params.provider === "google_sheets" ? cfg.google : cfg.microsoft;
  const admin = createAdminClient();
  if (!conf || !admin || !isEncryptionConfigured()) return json({ error: "This integration is not configured on the server yet." }, 503);

  const state = newState();
  const verifier = newCodeVerifier();
  const saved = await saveState(admin, { state, firmId: g.membership.firmId, userId: g.user.id, provider: params.provider, verifier });
  if (!saved) return json({ error: "The connection could not be started. Try again." }, 500);
  const url = params.provider === "google_sheets" ? googleAuthUrl(cfg.google!, state, verifier) : microsoftAuthUrl(cfg.microsoft!, state, verifier);
  return json({ url });
}
