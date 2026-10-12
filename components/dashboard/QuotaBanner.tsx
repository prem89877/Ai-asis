import Link from "next/link";
import { AlertTriangle, XCircle } from "lucide-react";
import { usageLevel, usagePercent } from "@/lib/billing/plans";
import type { BillingOverview } from "@/lib/billing/types";

// Warning at 80% and 100% of the plan's invoice quota, and when the subscription is not active.
// The numbers come from the server (billing_overview); this only displays them.
export function QuotaBanner({ billing }: { billing: BillingOverview | null }) {
  if (!billing) return null;
  const { plan, usage, subscription, can_process } = billing;
  const level = usageLevel(usage.used, usage.limit);

  if (!can_process) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
        <span className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Your subscription is {subscription.status === "past_due" ? "past due" : "suspended"}. New invoices cannot be processed until it is fixed. Existing invoices and exports still work.
        </span>
        <Link href="/dashboard/billing" className="font-semibold underline">Open Billing</Link>
      </div>
    );
  }
  if (level === "ok") return null;

  const full = level === "full";
  return (
    <div role="alert" className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm ${full ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
      <span className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {full
          ? `You have used all ${usage.limit.toLocaleString("en-IN")} invoices in your ${plan.name} plan for this billing period. New uploads stay "Uploaded" until you upgrade or the next period starts.`
          : `You have used ${usagePercent(usage.used, usage.limit)}% of your ${plan.name} plan (${usage.used.toLocaleString("en-IN")} of ${usage.limit.toLocaleString("en-IN")} invoices).`}
      </span>
      <Link href="/dashboard/billing" className="font-semibold underline">Upgrade plan</Link>
    </div>
  );
}
