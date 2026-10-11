"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Eye, FileText, Loader2, Play, RotateCcw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReviewStatusBadge } from "@/components/ui/ReviewStatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDay, formatInr } from "@/lib/format";
import { warningChips, type ReviewRow, type Summary } from "@/lib/review/client-types";
import { reviewState } from "@/lib/review/status";

type SortKey = "created_at" | "invoice_date" | "vendor_name" | "invoice_number" | "taxable_amount" | "tax_total" | "total_amount" | "status" | "flag_count";

const TABS: { id: string; label: string; count: (s: Summary) => number }[] = [
  { id: "", label: "All", count: (s) => s.total },
  { id: "processing", label: "Processing", count: (s) => s.processing },
  { id: "needs_review", label: "Needs review", count: (s) => s.needs_review },
  { id: "verified", label: "Verified", count: (s) => s.verified },
  { id: "failed", label: "Failed", count: (s) => s.failed },
];

const WARNINGS = [
  { id: "", label: "Any warnings" },
  { id: "missing_gstin", label: "GSTIN missing or invalid" },
  { id: "missing_invoice_number", label: "Invoice no. missing" },
  { id: "duplicate", label: "Possible duplicates" },
  { id: "tax_mismatch", label: "Tax/total mismatch" },
];

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "vendor_name", label: "Supplier" },
  { key: "invoice_number", label: "Invoice no." },
  { key: "invoice_date", label: "Date" },
  { key: "taxable_amount", label: "Taxable", align: "right" },
  { key: "tax_total", label: "GST", align: "right" },
  { key: "total_amount", label: "Total", align: "right" },
  { key: "status", label: "Status" },
];

interface Props {
  summary: Summary | null;
  refreshKey: number;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  busyId: string | null;
  onReview: (id: string, pageIds: string[]) => void;
  onExtract: (id: string, status: string) => void;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  /** Called when the list has rows still processing, so the parent can refresh counts too. */
  onPolled: () => void;
}

const PAGE_SIZE = 25;

export function InvoiceReviewTable({ summary, refreshKey, selected, onSelectedChange, busyId, onReview, onExtract, onDownload, onDelete, onExport, onPolled }: Props) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState("");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [capNote, setCapNote] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, dir });
      if (debouncedQ) p.set("q", debouncedQ);
      if (status) p.set("status", status);
      if (warning) p.set("warning", warning);
      for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
      return p;
    },
    [page, sort, dir, debouncedQ, status, warning]
  );

  const load = useCallback(
    async (silent: boolean) => {
      const id = ++requestId.current;
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/review/invoices?${params().toString()}`, { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as { invoices?: ReviewRow[]; total?: number; error?: string };
        if (id !== requestId.current) return;
        if (!res.ok) {
          setError(body.error ?? "The invoices could not be loaded.");
        } else {
          setRows(body.invoices ?? []);
          setTotal(body.total ?? 0);
          setError(null);
        }
      } catch {
        if (id === requestId.current) setError("Network error. Check your connection and try again.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [params]
  );

  useEffect(() => {
    void load(false);
  }, [load, refreshKey]);

  // While anything is still processing, refresh quietly every 5 seconds.
  const anyProcessing = rows.some((r) => reviewState(r.status) === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const t = setInterval(() => {
      void load(true);
      onPolled();
    }, 5000);
    return () => clearInterval(t);
  }, [anyProcessing, load, onPolled]);

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }

  function toggleSort(key: SortKey) {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "vendor_name" || key === "invoice_number" ? "asc" : "desc");
    }
    setPage(1);
  }

  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }
  function togglePage() {
    const next = new Set(selected);
    if (allOnPage) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    onSelectedChange(next);
  }
  async function selectAllMatching() {
    setSelectingAll(true);
    setCapNote(null);
    try {
      const res = await fetch(`/api/review/invoices?${params({ idsOnly: "1" }).toString()}`, { cache: "no-store" });
      const body = (await res.json()) as { ids?: string[]; total?: number; capped?: boolean; error?: string };
      if (res.ok && body.ids) {
        onSelectedChange(new Set([...Array.from(selected), ...body.ids]));
        if (body.capped) setCapNote(`Only the first ${body.ids.length} of ${body.total} matching invoices were selected (the export limit).`);
      } else setCapNote(body.error ?? "Could not select all.");
    } catch {
      setCapNote("Network error. Try again.");
    }
    setSelectingAll(false);
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(debouncedQ || status || warning);

  const rowActions = (r: ReviewRow) => {
    const state = reviewState(r.status);
    const hasData = r.status === "completed" || r.status === "needs_review" || r.status === "verified";
    const btn = "inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-50";
    return (
      <div className="flex gap-0.5">
        {(r.status === "uploaded" || r.status === "queued" || r.status === "failed") && (
          <button type="button" disabled={busyId === r.id} onClick={() => onExtract(r.id, r.status)} className={btn} aria-label={`${r.status === "failed" ? "Retry" : "Extract"} ${r.original_filename}`} title={r.status === "failed" ? "Retry extraction" : "Extract data"}>
            {r.status === "failed" ? <RotateCcw className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          </button>
        )}
        {(hasData || state === "failed") && (
          <button type="button" onClick={() => onReview(r.id, pageIds)} className={btn} aria-label={`${hasData ? "Review" : "View"} ${r.original_filename}`} title={hasData ? "Review and edit" : "View details"}>
            <Eye className="h-4 w-4" aria-hidden />
          </button>
        )}
        <button type="button" disabled={busyId === r.id} onClick={() => onDownload(r.id)} className={btn} aria-label={`Download ${r.original_filename}`} title="Download original">
          <Download className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" disabled={busyId === r.id} onClick={() => onDelete(r.id)} className={`${btn} text-red-700 hover:bg-red-50`} aria-label={`Delete ${r.original_filename}`} title="Delete">
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  };

  const chips = (r: ReviewRow) => {
    const list = warningChips(r);
    if (list.length === 0) return null;
    return (
      <ul className="mt-1 flex flex-wrap gap-1" aria-label="Warnings">
        {list.map((c) => (
          <li key={c.key} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${c.tone === "error" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}>{c.label}</li>
        ))}
      </ul>
    );
  };

  return (
    <section aria-labelledby="invoices-title" className="rounded-xl border border-slate-200 bg-white shadow-card">
      <div className="space-y-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="invoices-title" className="text-base font-semibold">Invoices</h2>
          <Button onClick={onExport} disabled={selected.size === 0}>
            <Download className="h-4 w-4" aria-hidden />
            Export{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </div>

        <div role="tablist" aria-label="Filter by status" className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={status === t.id} onClick={() => resetPage(setStatus)(t.id)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${status === t.id ? "bg-brand text-white" : "bg-slate-100 text-ink hover:bg-slate-200"}`}>
              {t.label}{summary ? ` (${t.count(summary)})` : ""}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Search invoices</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input type="search" value={q} onChange={(e) => resetPage(setQ)(e.target.value)} placeholder="Search supplier, invoice no., GSTIN, file" className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm" />
          </label>
          <label>
            <span className="sr-only">Filter by warning</span>
            <select value={warning} onChange={(e) => resetPage(setWarning)(e.target.value)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm sm:w-56">
              {WARNINGS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-brand-soft px-3 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <button type="button" className="font-medium text-brand underline" onClick={() => onSelectedChange(new Set())}>Clear</button>
            {total > rows.length && (
              <button type="button" disabled={selectingAll} className="font-medium text-brand underline disabled:opacity-60" onClick={selectAllMatching}>
                {selectingAll ? "Selecting..." : `Select all ${total} matching`}
              </button>
            )}
          </div>
        )}
        {capNote && <p className="text-xs text-amber-800" role="status">{capNote}</p>}
      </div>

      {error && (
        <div className="m-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
          <span>{error}</span>
          <Button variant="secondary" onClick={() => void load(false)}>Try again</Button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-3 p-5" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : !error && rows.length === 0 ? (
        filtered ? (
          <EmptyState icon={Search} title="No invoices match" description="Change or clear the search and filters." action={<Button variant="secondary" onClick={() => { setQ(""); setStatus(""); setWarning(""); setPage(1); }}>Clear filters</Button>} />
        ) : (
          <EmptyState icon={FileText} title="No invoices yet" description="Upload your first invoices. They are read by AI, then wait here for your review." />
        )
      ) : (
        <>
          <div className={`relative ${loading ? "opacity-60" : ""}`}>
            {loading && <Loader2 className="absolute right-4 top-3 h-4 w-4 animate-spin text-ink-muted" aria-label="Loading" />}

            {/* Desktop / tablet table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] text-left text-sm">
                <caption className="sr-only">Invoices for review</caption>
                <thead className="bg-slate-50 text-ink-muted">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-3">
                      <input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all invoices on this page" className="h-4 w-4" />
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} scope="col" aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : "none"} className={`px-3 py-3 font-medium ${c.align === "right" ? "text-right" : ""}`}>
                        <button type="button" onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 hover:text-ink">
                          {c.label}
                          {sort === c.key && (dir === "asc" ? <ArrowUp className="h-3.5 w-3.5" aria-hidden /> : <ArrowDown className="h-3.5 w-3.5" aria-hidden />)}
                        </button>
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className={selected.has(r.id) ? "bg-brand-soft/50" : undefined}>
                      <td className="px-3 py-3 align-top"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label={`Select ${r.original_filename}`} className="h-4 w-4" /></td>
                      <td className="max-w-[240px] px-3 py-3 align-top">
                        <div className="truncate font-medium">{r.vendor_name ?? <span className="text-ink-muted">{r.original_filename}</span>}</div>
                        {r.vendor_gstin && <div className="text-xs tabular-nums text-ink-muted">{r.vendor_gstin}</div>}
                        {chips(r)}
                      </td>
                      <td className="px-3 py-3 align-top">{r.invoice_number ?? <span className="text-ink-muted">-</span>}</td>
                      <td className="whitespace-nowrap px-3 py-3 align-top">{formatDay(r.invoice_date) || <span className="text-ink-muted">-</span>}</td>
                      <td className="px-3 py-3 text-right tabular-nums align-top">{formatInr(r.taxable_amount)}</td>
                      <td className="px-3 py-3 text-right tabular-nums align-top">{formatInr(r.tax_total)}</td>
                      <td className="px-3 py-3 text-right tabular-nums align-top">{formatInr(r.total_amount)}</td>
                      <td className="px-3 py-3 align-top">
                        <ReviewStatusBadge status={r.status} />
                        {r.flag_count > 0 && r.status !== "verified" && <div className="mt-1 text-xs text-ink-muted">{r.flag_count} flag{r.flag_count === 1 ? "" : "s"}</div>}
                      </td>
                      <td className="px-3 py-2 align-top">{rowActions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone: one card per invoice */}
            <ul className="divide-y divide-slate-100 md:hidden">
              <li className="flex items-center gap-2 px-4 py-2 text-sm">
                <input id="sel-page" type="checkbox" checked={allOnPage} onChange={togglePage} className="h-5 w-5" />
                <label htmlFor="sel-page">Select all on this page</label>
              </li>
              {rows.map((r) => (
                <li key={r.id} className={`px-4 py-3 ${selected.has(r.id) ? "bg-brand-soft/50" : ""}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label={`Select ${r.original_filename}`} className="mt-1 h-5 w-5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate font-medium">{r.vendor_name ?? r.original_filename}</p>
                        <ReviewStatusBadge status={r.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {[r.invoice_number, formatDay(r.invoice_date)].filter(Boolean).join(" · ") || r.original_filename}
                      </p>
                      {r.total_amount !== null && (
                        <p className="mt-1 text-sm tabular-nums">Total {formatInr(r.total_amount)}<span className="text-ink-muted"> · GST {formatInr(r.tax_total) || "-"}</span></p>
                      )}
                      {chips(r)}
                      <div className="-ml-2 mt-1">{rowActions(r)}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm sm:px-5">
            <span className="text-ink-muted">{total} invoice{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" aria-hidden /></Button>
              <span aria-live="polite">Page {page} of {pages}</span>
              <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" aria-hidden /></Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
