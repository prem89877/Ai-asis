import { AlertTriangle, CheckCircle2, Clock, PauseCircle } from "lucide-react";
import type { SubscriptionStatus } from "@/lib/billing/types";

const config: Record<SubscriptionStatus, { label: string; className: string; Icon: typeof Clock }> = {
  active: { label: "Active", className: "bg-success-soft text-success-ink", Icon: CheckCircle2 },
  trialing: { label: "Trial", className: "bg-brand-soft text-blue-800", Icon: Clock },
  past_due: { label: "Payment overdue", className: "bg-amber-50 text-amber-900", Icon: AlertTriangle },
  suspended: { label: "Suspended", className: "bg-red-50 text-red-800", Icon: PauseCircle },
};

export function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  const c = config[status] ?? config.suspended;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${c.className}`}>
      <c.Icon className="h-3.5 w-3.5" aria-hidden />
      {c.label}
    </span>
  );
}
