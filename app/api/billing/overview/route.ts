import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { getBillingOverview } from "@/lib/billing/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Current plan, subscription status and quota for the signed-in user's firm.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const overview = await getBillingOverview(g.supabase, g.membership.firmId);
  if (!overview) return json({ error: "Billing details could not be loaded." }, 500);
  return json({ overview, role: g.membership.role, canManage: g.membership.role === "owner" || g.membership.role === "admin" });
}
