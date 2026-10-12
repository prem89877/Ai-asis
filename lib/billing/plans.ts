import type { PlanInfo } from "@/lib/billing/types";

// Fallback shown ONLY when the plans table cannot be read (for example before the Phase 5 migration is run).
// The database is the source of truth: change prices and limits there. Keep this list in step with the seed.
// PROPOSED prices and limits, not final commitments.
export const FALLBACK_PLANS: PlanInfo[] = [
  {
    code: "pilot", name: "Pilot", tagline: "Try the workflow on real invoices",
    price_paise: 0, price_max_paise: null, currency: "INR", monthly_invoice_limit: 25, batch_max_files: 5,
    features: ["25 invoices per month", "Up to 5 files per upload", "AI extraction with GST checks", "Review, verify and export (CSV and Excel)"],
    sort_order: 10, is_proposed: true,
  },
  {
    code: "solo", name: "Solo", tagline: "For a single CA or consultant",
    price_paise: 79900, price_max_paise: null, currency: "INR", monthly_invoice_limit: 300, batch_max_files: 20,
    features: ["300 invoices per month", "Up to 20 files per upload", "AI extraction with GST checks", "Review, verify and export (CSV and Excel)", "Email support"],
    sort_order: 20, is_proposed: true,
  },
  {
    code: "ca_firm", name: "CA Firm", tagline: "For firms handling many clients",
    price_paise: 149900, price_max_paise: 299900, currency: "INR", monthly_invoice_limit: 1500, batch_max_files: 50,
    features: ["1,500 invoices per month", "Up to 50 files per upload", "AI extraction with GST checks", "Review, verify and export (CSV and Excel)", "Priority support"],
    sort_order: 30, is_proposed: true,
  },
];

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

// "Free", "₹799", or "₹1,499 – ₹2,999" for a range. Prices are stored in paise.
export function formatPlanPrice(plan: Pick<PlanInfo, "price_paise" | "price_max_paise">): string {
  if (plan.price_paise === 0) return "Free";
  if (plan.price_max_paise !== null && plan.price_max_paise > plan.price_paise) {
    return `${rupees(plan.price_paise)} – ${rupees(plan.price_max_paise)}`;
  }
  return rupees(plan.price_paise);
}

export type ChangeKind = "current" | "upgrade" | "downgrade";

// Same rule as the database: plans are ordered by sort_order.
export function changeKind(current: Pick<PlanInfo, "code" | "sort_order">, target: Pick<PlanInfo, "code" | "sort_order">): ChangeKind {
  if (current.code === target.code) return "current";
  return target.sort_order > current.sort_order ? "upgrade" : "downgrade";
}

export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}
