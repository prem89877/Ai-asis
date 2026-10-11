import { AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import type { InvoiceStatus } from "@/lib/sample-data";

const config: Record<InvoiceStatus, { label: string; className: string; Icon: typeof Clock }> = {
  verified: { label: "Verified", className: "bg-success-soft text-success-ink", Icon: CheckCircle2 },
  needs_review: { label: "Needs review", className: "bg-amber-50 text-amber-900", Icon: AlertTriangle },
  processing: { label: "Processing", className: "bg-brand-soft text-blue-800", Icon: Clock },
  error: { label: "Error", className: "bg-red-50 text-red-800", Icon: XCircle },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const { label, className, Icon } = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}
