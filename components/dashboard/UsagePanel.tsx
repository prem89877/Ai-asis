import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { userMessage } from "@/lib/extraction/errors";
import { formatDate } from "@/lib/format";
import type { JobRow, Summary } from "@/lib/review/client-types";

interface Props {
  summary: Summary | null;
  monthlyLimit: number;
  jobs: JobRow[];
}

// AI processing usage for this month and the latest jobs. Cost is an estimate from list prices, not an invoice.
export function UsagePanel({ summary, monthlyLimit, jobs }: Props) {
  const used = summary?.month_jobs ?? 0;
  const pct = monthlyLimit > 0 ? Math.min(100, Math.round((used / monthlyLimit) * 100)) : 0;
  const active = jobs.filter((j) => j.status === "queued" || j.status === "processing");
  const failures = jobs.filter((j) => j.status === "failed").slice(0, 3);
  return (
    <section aria-labelledby="usage-title" className="rounded-xl border border-slate-200 bg-white shadow-card">
      <h2 id="usage-title" className="border-b border-slate-100 px-5 py-4 text-base font-semibold">AI processing this month</h2>
      <div className="space-y-4 p-5 text-sm">
        {!summary ? (
          <p className="text-ink-muted">Usage is not available right now.</p>
        ) : (
          <>
            <div>
              <div className="flex justify-between"><span>Extractions used</span><span className="tabular-nums font-medium">{used} / {monthlyLimit}</span></div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly extraction usage">
                <div className={`h-full ${pct >= 90 ? "bg-amber-500" : "bg-success"}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs text-ink-muted">
              <div><dt>Succeeded</dt><dd className="text-base font-semibold text-ink tabular-nums">{summary.month_succeeded}</dd></div>
              <div><dt>Failed</dt><dd className="text-base font-semibold text-ink tabular-nums">{summary.month_failed}</dd></div>
              <div><dt>Tokens (in / out)</dt><dd className="text-sm font-medium text-ink tabular-nums">{Number(summary.month_input_tokens).toLocaleString("en-IN")} / {Number(summary.month_output_tokens).toLocaleString("en-IN")}</dd></div>
              <div><dt>Estimated cost</dt><dd className="text-sm font-medium text-ink tabular-nums">${Number(summary.month_cost_usd).toFixed(4)}</dd></div>
              <div><dt>Exports</dt><dd className="text-sm font-medium text-ink tabular-nums">{summary.month_exports} ({summary.month_exported_invoices} invoices)</dd></div>
            </dl>
          </>
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
