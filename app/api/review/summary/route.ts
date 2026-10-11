import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { getLimits } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Counts and usage for the dashboard cards. The database function is SECURITY INVOKER, so RLS applies.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.rpc("review_summary", { p_firm_id: g.membership.firmId });
  if (error || !data) {
    console.error("review_summary_failed", { code: error?.code ?? null });
    return json({ error: "The summary could not be loaded." }, 500);
  }
  return json({ summary: data, monthlyLimit: getLimits().monthlyLimit });
}
