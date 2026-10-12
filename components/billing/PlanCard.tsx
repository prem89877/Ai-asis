import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { displayFeatures, formatPlanPrice } from "@/lib/billing/plans";
import type { PlanInfo } from "@/lib/billing/types";

interface PlanCardProps {
  plan: PlanInfo;
  /** small label above the name, for example "Current plan" */
  badge?: string;
  highlight?: boolean;
  /** the call to action (button, link or short message) */
  children?: ReactNode;
}

// One plan. Every number and price comes from the plan data (the plans table); nothing is hardcoded here.
export function PlanCard({ plan, badge, highlight = false, children }: PlanCardProps) {
  const free = plan.price_paise === 0;
  return (
    <div className={cn("flex flex-col rounded-xl border bg-white p-6 shadow-card", highlight ? "border-brand ring-1 ring-brand" : "border-slate-200")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        {badge && <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-blue-800">{badge}</span>}
      </div>
      {plan.tagline && <p className="mt-1 text-sm text-ink-muted">{plan.tagline}</p>}

      <p className="mt-4 text-3xl font-bold tracking-tight">
        {formatPlanPrice(plan)}
        {!free && <span className="ml-1 text-base font-medium text-ink-muted">/month</span>}
      </p>
      {plan.is_proposed && <p className="mt-1 text-xs text-ink-muted">Proposed pricing</p>}

      <dl className="mt-5 grid grid-cols-2 gap-3 rounded-lg bg-canvas p-3 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">Invoices per month</dt>
          <dd className="text-base font-semibold tabular-nums">{plan.monthly_invoice_limit.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Files per upload</dt>
          <dd className="text-base font-semibold tabular-nums">{plan.batch_max_files.toLocaleString("en-IN")}</dd>
        </div>
      </dl>

      <ul className="mt-5 flex-1 space-y-3 text-sm">
        {displayFeatures(plan).map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-ink" aria-hidden />
            {f}
          </li>
        ))}
      </ul>

      {children && <div className="mt-6">{children}</div>}
    </div>
  );
}
