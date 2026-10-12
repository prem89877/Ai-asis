// Server-side billing helpers. Import from server code only (routes and server components).
import type { SupabaseClient } from "@supabase/supabase-js";
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

// Public plans, cheapest first. Falls back to the built-in list only if the table cannot be read.
export async function listPlans(supabase: SupabaseClient): Promise<{ plans: PlanInfo[]; fromDatabase: boolean }> {
  const { data, error } = await supabase
    .from("plans")
    .select("code, name, tagline, price_paise, price_max_paise, currency, monthly_invoice_limit, batch_max_files, features, sort_order, is_proposed")
    .order("sort_order", { ascending: true });
  if (error || !data || data.length === 0) return { plans: FALLBACK_PLANS, fromDatabase: false };
  return { plans: data as unknown as PlanInfo[], fromDatabase: true };
}

// Testing aid: lets a plan upgrade apply without payment. It is IGNORED on a Vercel production deployment.
// Leave BILLING_ALLOW_UNPAID_UPGRADES unset in production; the payment phase is what confirms paid upgrades.
export function allowUnpaidUpgrades(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.BILLING_ALLOW_UNPAID_UPGRADES?.trim().toLowerCase() === "true";
}
