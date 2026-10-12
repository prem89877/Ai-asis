import Link from "next/link";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { userMessage } from "@/lib/extraction/errors";
import { formatDate, formatDayIST } from "@/lib/format";
import { formatPlanPrice, usageLevel, usagePercent } from "@/lib/billing/plans";
import type { BillingOverview } from "@/lib/billing/types";
import type { JobRow, Summary } from "@/lib/review/client-types";

interface Props {
  summary: Summary | null;
  /** Plan quota from the server. null = could not be loaded. */
  billing: BillingOverview | null;
  jobs: JobRow[];
}

// Plan usage (quota units, from billing_overview) and AI processing statistics for the calendar month.
// Cost is an estimate from list prices, not an invoice.
export function UsagePanel({ summary, billing, jobs }: Props) {
  const active = jobs.filter((j) => j.status === "queued" || j.status === "processing");
  const failures = jobs.filter((j) => j.status === "failed").slice(0, 3);
  const used = billing?.usage.used ?? 0;
  const limit = billing?.usage.limit ?? 0;
  const pct = usagePercent(used, limit);
  const level = usageLevel(used, limit);
  const barColor = level === "full" ? "bg-red-600" : level === "warning" ? "bg-amber-500" : "bg-success";

  return (
    <section aria-labelledby="usage-title" className="rounded-xl border border-slate-200 bg-white shadow-card">
      <h2 id="usage-title" className="border-b border-slate-100 px-5 py-4 text-base font-semibold">Plan usage</h2>
      <div className="space-y-4 p-5 text-sm">
        {!billing ? (
          <p className="text-ink-muted">Your plan and invoice quota are not available right now. If you just updated the app, check that the Phase 5 database migrations have been run.</p>
        ) : (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{billing.plan.name} <span className="font-normal text-ink-muted">({formatPlanPrice(billing.plan)}{billing.plan.price_paise > 0 ? "/month" : ""})</span></span>
              <Link href="/dashboard/billing" className="text-xs font-semibold text-brand hover:underline">{level === "ok" ? "Billing" : "Upgrade plan"}</Link>
            </div>
            <div className="mt-3 flex justify-between"><span>Invoices used this period</span><span className="tabular-nums font-medium">{used.toLocaleString("en-IN")} / {limit.toLocaleString("en-IN")}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Invoices used this billing period">
              <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {billing.usage.remaining.toLocaleString("en-IN")} remaining · period ends {formatDayIST(billing.subscription.current_period_end)} · up to {billing.plan.batch_max_files} files per upload
            </p>
          </div>
        )}

        {!summary ? (
          <p className="text-ink-muted">AI processing statistics are not available right now.</p>
        ) : (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">AI processing, calendar month</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-muted">
              <div><dt>Succeeded</dt><dd className="text-base font-semibold text-ink tabular-nums">{summary.month_succeeded}</dd></div>
              <div><dt>Failed</dt><dd className="text-base font-semibold text-ink tabular-nums">{summary.month_failed}</dd></div>
              <div><dt>Tokens (in / out)</dt><dd className="text-sm font-medium text-ink tabular-nums">{Number(summary.month_input_tokens).toLocaleString("en-IN")} / {Number(summary.month_output_tokens).toLocaleString("en-IN")}</dd></div>
              <div><dt>Estimated cost</dt><dd className="text-sm font-medium text-ink tabular-nums">${Number(summary.month_cost_usd).toFixed(4)}</dd></div>
              <div><dt>Exports</dt><dd className="text-sm font-medium text-ink tabular-nums">{summary.month_exports} ({summary.month_exported_invoices} invoices)</dd></div>
            </dl>
          </div>
        )}
        {active.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 font-medium"><Clock className="h-4 w-4 text-brand" aria-hidden />In progress ({active.length})</p>
            <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">{active.map((j) => <li key={j.id} className="truncate">{j.filename}: {j.status}</li>)}</ul>
          </div>
        )}
        {failures.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 font-medium"><AlertCircle className="h-4 w-4 text-red-700" aria-hidden />Recent failures</p>
            <ul className="mt-1 space-y-1 text-xs text-ink-muted">
              {failures.map((j) => <li key={j.id}><span className="font-medium text-ink">{j.filename}</span>: {userMessage(j.error_code) ?? "Failed."}{j.finished_at ? ` (${formatDate(j.finished_at)})` : ""}</li>)}
            </ul>
          </div>
        )}
        {summary && active.length === 0 && failures.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />No jobs running and no recent failures.</p>
        )}
      </div>
    </section>
  );
}
