import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEncryptionConfigured } from "@/lib/integrations/crypto";
import { companiesRequestXml, parseCompanies, postToTally, validateTallyUrl } from "@/lib/integrations/tally-push";
import { saveTallyConnection } from "@/lib/integrations/store";
import { userMessage } from "@/lib/integrations/http";
import { DEFAULT_TALLY_CONFIG } from "@/lib/tally/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Saves the public address of the firm's TallyPrime connection (encrypted) after asking Tally for its open companies.
// Body: { url: "https://...", token?: "..." }. EXPERIMENTAL: see docs/PHASE7_INTEGRATIONS_SETUP.md.
export async function POST(request: Request) {
  if (process.env.TALLY_EXPORT_ENABLED === "false") return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  if (g.membership.role !== "owner" && g.membership.role !== "admin") return json({ error: "Only a firm owner or admin can connect Tally." }, 403);
  const admin = createAdminClient();
  if (!admin || !isEncryptionConfigured()) return json({ error: "This integration is not configured on the server yet." }, 503);

  const body = await readJsonBody(request, 4 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);
  const u = validateTallyUrl(b.url);
  if (!u.ok) return json({ error: u.message }, 400);
  const token = typeof b.token === "string" && b.token.trim() ? b.token.trim() : null;
  if (token && (token.length > 300 || /[\r\n]/.test(token))) return json({ error: "The access token is not valid." }, 400);

  let companies: string[];
  try {
    companies = parseCompanies(await postToTally(u.url, token, companiesRequestXml()));
  } catch (e) {
    const m = userMessage(e);
    return json({ error: m.code === "permission_denied" ? "Tally refused the connection (wrong token, or the address points to a private network)." : "Tally could not be reached at that address. Check that TallyPrime is open, its server is on, and the tunnel is running.", code: m.code }, 502);
  }
  const ok = await saveTallyConnection(admin, { firmId: g.membership.firmId, userId: g.user.id, secret: { url: u.url.toString(), token }, target: { host: u.url.hostname, companies, config: { ...DEFAULT_TALLY_CONFIG, companyName: companies.length === 1 && /^[^\u0000-\u001F<>&"]{1,100}$/.test(companies[0]) ? companies[0] : "" } } });
  if (!ok) return json({ error: "The connection could not be saved. Try again." }, 500);
  return json({ ok: true, companies });
}
