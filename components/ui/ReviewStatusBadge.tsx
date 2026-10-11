import { AlertTriangle, CheckCircle2, Loader2, Trash2, XCircle } from "lucide-react";
import { reviewState, statusDetail, type ReviewState } from "@/lib/review/status";
import { REVIEW_STATE_LABEL } from "@/lib/review/status";

const config: Record<ReviewState, { className: string; Icon: typeof XCircle; spin?: boolean }> = {
  processing: { className: "bg-brand-soft text-blue-800", Icon: Loader2, spin: true },
  needs_review: { className: "bg-amber-50 text-amber-900", Icon: AlertTriangle },
  verified: { className: "bg-success-soft text-success-ink", Icon: CheckCircle2 },
  failed: { className: "bg-red-50 text-red-800", Icon: XCircle },
  deleting: { className: "bg-slate-100 text-slate-700", Icon: Trash2 },
};

// The four review states people care about. Icon + text, never colour alone. The exact database status is in the tooltip.
export function ReviewStatusBadge({ status }: { status: string }) {
  const state = reviewState(status);
  const { className, Icon, spin } = config[state];
  return (
    <span title={statusDetail(status)} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>
      <Icon className={`h-3.5 w-3.5 ${spin && status === "processing" ? "animate-spin" : ""}`} aria-hidden />
      {REVIEW_STATE_LABEL[state]}
      {status === "queued" && <span className="font-normal">(queued)</span>}
      {status === "uploaded" && <span className="font-normal">(waiting)</span>}
    </span>
  );
}
