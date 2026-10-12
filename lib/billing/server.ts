// Server-side billing helpers. Import from server code only (routes and server components).
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { FALLBACK_PLANS } from "@/lib/billing/plans";
import type { BillingOverview, PlanInfo } from "@/lib/billing/types";

// Plan, subscription and usage for the caller's firm. The database function returns null for a firm the
// caller does not belong to, so a wrong firm id can never leak another tenant's billing data.
export async function getBillingOverview(supabase: SupabaseClient, firmId: string): Promise<BillingOverview | null> {
  const { data, error } = await supabase.rpc("billing_overview", { p_firm_id: firmId });
  if (error || !data) {
    if (error) console.error("billing_overview_failed", { code: error.code ?? null });
    return null;
  }
  return data as BillingOverview;
}

const PLAN_COLUMNS = "code, name, tagline, price_paise, price_max_paise, currency, monthly_invoice_limit, batch_max_files, features, sort_order, is_proposed";

// Plans for public pages (landing page). Uses the anon key without cookies, so the page can be cached.
// Prices are refreshed at most every 5 minutes. Falls back to the built-in list if the table cannot be read.
export async function listPublicPlans(): Promise<{ plans: PlanInfo[]; fromDatabase: boolean }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { plans: FALLBACK_PLANS, fromDatabase: false };
  try {
    const client = createSupabaseClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, next: { revalidate: 300 } } as RequestInit) },
    });
    const { data, error } = await client.from("plans").select(PLAN_COLUMNS).order("sort_order", { ascending: true });
    if (error || !data || data.length === 0) return { plans: FALLBACK_PLANS, fromDatabase: false };
    return { plans: data as unknown as PlanInfo[], fromDatabase: true };
  } catch {
    return { plans: FALLBACK_PLANS, fromDatabase: false };
  }
}

// Public plans, cheapest first. Falls back to the built-in list only if the table cannot be read.
export async function listPlans(supabase: SupabaseClient): Promise<{ plans: PlanInfo[]; fromDatabase: boolean }> {
  const { data, error } = await supabase
    .from("plans")
    .select(PLAN_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error || !data || data.length === 0) return { plans: FALLBACK_PLANS, fromDatabase: false };
  return { plans: data as unknown as PlanInfo[], fromDatabase: true };
}

// Re-exported so existing imports keep working. The logic lives in flags.ts (dependency-free, unit tested).
export { allowUnpaidUpgrades } from "@/lib/billing/flags";
