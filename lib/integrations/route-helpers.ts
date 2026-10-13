// Shared start of every connection route: same-origin check (mutations), signed-in user, firm membership,
// owner/admin role, then the connection row looked up BY ID AND FIRM with the service role (so token columns can be read
// on the server only). A connection id of another firm looks like "not found".
import type { SupabaseClient } from "@supabase/supabase-js";
import { guard } from "@/lib/api/guard";
import type { Guard } from "@/lib/api/guard";
import { json } from "@/lib/api/json";
import { UUID_RE } from "@/lib/invoices/validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { IntegrationError, userMessage } from "./http.ts";
import type { Connection } from "./store.ts";

export type ConnectionContext =
  | { ok: true; g: Extract<Guard, { ok: true }>; admin: SupabaseClient; conn: Connection }
  | { ok: false; response: Response };

export async function managerWithConnection(request: Request, id: string, mutating: boolean): Promise<ConnectionContext> {
  if (!UUID_RE.test(id)) return { ok: false, response: json({ error: "Not found." }, 404) };
  const g = await guard(request, { mutating });
  if (!g.ok) return { ok: false, response: g.response };
  if (g.membership.role !== "owner" && g.membership.role !== "admin") return { ok: false, response: json({ error: "Only a firm owner or admin can manage integrations." }, 403) };
  const admin = createAdminClient();
  if (!admin) return { ok: false, response: json({ error: "This integration is not configured on the server yet." }, 503) };
  const { data, error } = await admin.from("integration_connections").select("*").eq("id", id).eq("firm_id", g.membership.firmId).maybeSingle();
  if (error) return { ok: false, response: json({ error: "The connection could not be loaded. Try again." }, 500) };
  if (!data) return { ok: false, response: json({ error: "Not found." }, 404) };
  return { ok: true, g, admin, conn: data as Connection };
}

const STATUS: Record<string, number> = { auth_expired: 409, permission_denied: 403, not_found: 404, rate_limited: 429, timeout: 504, server_error: 502, network: 502, bad_request: 502, header_changed: 409 };

// Answer for a failed provider call: a safe message and a status the screen can act on. Never the provider's own text.
export function providerError(e: unknown): Response {
  const m = userMessage(e);
  const status = e instanceof IntegrationError ? (STATUS[e.code] ?? 502) : 502;
  return json({ error: m.message, code: m.code }, status, status === 429 ? { "Retry-After": "30" } : {});
}
