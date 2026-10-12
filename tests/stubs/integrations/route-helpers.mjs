// MOCK / stand-in for lib/integrations/route-helpers. It uses the REAL guard (origin check, session, firm membership) and
// then looks the connection up by id AND firm_id. The real helper may differ in detail: re-run these tests against it.
import { guard } from "@/lib/api/guard";
import { json } from "@/lib/api/json";
import { createAdminClient } from "@/lib/supabase/admin";
import { IntegrationError, userMessage } from "./http.mjs";

export async function managerWithConnection(request, id, mutating) {
  const g = await guard(request, { mutating });
  if (!g.ok) return { ok: false, response: g.response };
  if (mutating && g.membership.role !== "owner" && g.membership.role !== "admin") return { ok: false, response: json({ error: "Only owners and admins can do this." }, 403) };
  const admin = createAdminClient();
  if (!admin) return { ok: false, response: json({ error: "Integrations are not configured." }, 503) };
  const { data: conn } = await g.supabase.from("integration_connections").select("*").eq("id", id).eq("firm_id", g.membership.firmId).maybeSingle();
  if (!conn) return { ok: false, response: json({ error: "Not found." }, 404) };
  return { ok: true, g, admin, conn };
}

const STATUS = { auth_expired: 409, rate_limited: 429, timeout: 504 };
export function providerError(e) {
  const m = userMessage(e);
  const status = e instanceof IntegrationError ? (STATUS[e.code] ?? 502) : 502;
  return json({ error: m.message, code: m.code }, status, status === 429 ? { "Retry-After": "30" } : {});
}
