import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { isEncryptionConfigured } from "@/lib/integrations/crypto";
import { providerConfigs, PUBLIC_CONNECTION_COLUMNS } from "@/lib/integrations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Connection status and recent sync results for the firm. Read through the user's session (Row Level Security);
// token columns are not granted to browsers at all and are not selected here.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const firmId = g.membership.firmId;
  const [conns, recent] = await Promise.all([
    g.supabase.from("integration_connections").select(PUBLIC_CONNECTION_COLUMNS).eq("firm_id", firmId),
    g.supabase.from("sync_records").select("id, connection_id, invoice_id, status, attempts, error_code, error_message, synced_at, updated_at, invoices(original_filename, invoice_number)").eq("firm_id", firmId).order("updated_at", { ascending: false }).limit(30),
  ]);
  if (conns.error) return json({ error: "Integrations could not be loaded. Check that the Phase 6 database migration has been run." }, 500);
  const cfg = providerConfigs();
  return json({
    connections: conns.data ?? [],
    recent: recent.data ?? [],
    canManage: g.membership.role === "owner" || g.membership.role === "admin",
    available: { google_sheets: !!cfg.google && isEncryptionConfigured(), microsoft_excel: !!cfg.microsoft && isEncryptionConfigured(), tally: process.env.TALLY_EXPORT_ENABLED !== "false" },
  });
}
