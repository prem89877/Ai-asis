import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { getBillingOverview } from "@/lib/billing/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Counts and usage for the dashboard cards. The database function is SECURITY INVOKER, so RLS applies.
// The invoice quota and batch limit come from the firm's plan (billing_overview), never from environment variables.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const [{ data, error }, billing] = await Promise.all([
    g.supabase.rpc("review_summary", { p_firm_id: g.membership.firmId }),
    getBillingOverview(g.supabase, g.membership.firmId),
  ]);
  if (error || !data) {
    console.error("review_summary_failed", { code: error?.code ?? null });
    return json({ error: "The summary could not be loaded." }, 500);
  }
  // billing is null only if the Phase 5 migration is missing or billing could not be read; the UI shows that state.
  return json({ summary: data, billing });
}
