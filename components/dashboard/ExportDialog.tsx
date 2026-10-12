"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Download, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS, INVOICE_COLUMNS, ITEM_COLUMNS } from "@/lib/export/columns";
import { EXPORT_PROFILES } from "@/lib/export/profiles";

interface Props {
  invoiceIds: string[];
  onClose: () => void;
  /** Called after a file was created and handed to the browser. */
  onExported: (message: { ok: boolean; text: string }) => void;
}

type Fmt = "xlsx" | "csv";

function move<T>(list: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function ColumnPicker({ title, all, chosen, onChange }: { title: string; all: readonly { key: string; label: string }[]; chosen: string[]; onChange: (c: string[]) => void }) {
  const label = (k: string) => all.find((c) => c.key === k)?.label ?? k;
  const rest = all.filter((c) => !chosen.includes(c.key));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">{title}</legend>
      <p className="text-xs text-ink-muted">Columns are exported in this order.</p>
      <ol className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {chosen.length === 0 && <li className="px-2 py-1 text-sm text-ink-muted">No columns chosen.</li>}
        {chosen.map((k, i) => (
          <li key={k} className="flex items-center gap-1 rounded bg-slate-50 px-2 py-1 text-sm">
            <span className="flex-1 truncate">{label(k)}</span>
            <button type="button" onClick={() => onChange(move(chosen, i, -1))} disabled={i === 0} aria-label={`Move ${label(k)} up`} className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-slate-200 disabled:opacity-30"><ArrowUp className="h-4 w-4" aria-hidden /></button>
            <button type="button" onClick={() => onChange(move(chosen, i, 1))} disabled={i === chosen.length - 1} aria-label={`Move ${label(k)} down`} className="inline-flex h-9 w-9 items-center justify-center rounded hover:bg-slate-200 disabled:opacity-30"><ArrowDown className="h-4 w-4" aria-hidden /></button>
            <button type="button" onClick={() => onChange(chosen.filter((x) => x !== k))} aria-label={`Remove ${label(k)}`} className="inline-flex h-9 w-9 items-center justify-center rounded text-red-700 hover:bg-red-50"><X className="h-4 w-4" aria-hidden /></button>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-brand">Add a column ({rest.length} available)</summary>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {rest.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={() => onChange([...chosen, c.key])} className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
                  <Plus className="h-3 w-3" aria-hidden />{c.label}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}

export function ExportDialog({ invoiceIds, onClose, onExported }: Props) {
  const [format, setFormat] = useState<Fmt>("xlsx");
  const [columns, setColumns] = useState<string[]>([...DEFAULT_COLUMNS]);
  const [itemColumns, setItemColumns] = useState<string[]>([...DEFAULT_ITEM_COLUMNS]);
  const [includeItems, setIncludeItems] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [dateFormat, setDateFormat] = useState<"iso" | "dmy">("iso");
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/exports/preferences", { cache: "no-store" });
        if (!res.ok) return;
        const p = (await res.json()) as { columns: string[]; itemColumns: string[]; includeItems: boolean; dateFormat: "iso" | "dmy" };
        if (cancelled) return;
        setColumns(p.columns);
        setItemColumns(p.itemColumns);
        setIncludeItems(p.includeItems);
        setDateFormat(p.dateFormat);
      } catch {
        /* defaults stay */
      } finally {
        if (!cancelled) setLoadingPrefs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const itemCols = format === "csv" ? ITEM_COLUMNS.filter((c) => !c.reference) : ITEM_COLUMNS;
  const effectiveItemColumns = format === "csv" ? itemColumns.filter((k) => itemCols.some((c) => c.key === k)) : itemColumns;
  const tooFew = columns.length === 0 || (includeItems && effectiveItemColumns.length === 0);

  async function savePrefs() {
    setSavingPrefs(true);
    setNote(null);
    setError(null);
    try {
      const res = await fetch("/api/exports/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ columns, itemColumns, includeItems, dateFormat }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setNote("Saved as your default columns.");
      else setError(body.error ?? "Could not save.");
    } catch {
      setError("Network error. Try again.");
    }
    setSavingPrefs(false);
  }

  async function run() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, profile: "standard", invoiceIds, columns, itemColumns: effectiveItemColumns, includeItems, verifiedOnly, dateFormat }),
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        let body: { error?: string; detail?: string } = {};
        try { body = JSON.parse(raw) as typeof body; } catch { /* not JSON */ }
        // TEMP-DEBUG: exact error (status, message, technical detail, raw body when it is not JSON)
        setError(`[${res.status}] ${body.error ?? "The export could not be created."}${body.detail ? `\nDETAIL: ${body.detail}` : ""}${!body.error && raw ? `\nRAW: ${raw.slice(0, 400)}` : ""}`);
        setBusy(false);
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `invoices.${format}`;
      const count = Number(res.headers.get("X-Export-Count") ?? 0);
      const skipped = Number(res.headers.get("X-Export-Skipped") ?? 0);
      const unverified = Number(res.headers.get("X-Export-Unverified") ?? 0);
      const histErr = res.headers.get("X-Export-History-Error"); // TEMP-DEBUG
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const parts = [`${name} created with ${count} invoice${count === 1 ? "" : "s"}.`];
      if (skipped > 0) parts.push(`${skipped} skipped (not extracted yet${verifiedOnly ? " or not verified" : ""}).`);
      if (unverified > 0) parts.push(`${unverified} not yet verified. Review them before using the figures.`);
      if (histErr) parts.push(`(history not saved: ${histErr})`); // TEMP-DEBUG
      onExported({ ok: true, text: parts.join(" ") });
    } catch (e) {
      // TEMP-DEBUG: exact browser-side error
      setError(`Browser error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/50 p-0 sm:items-start sm:p-4" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="export-title" className="w-full max-w-2xl rounded-t-2xl bg-white shadow-xl sm:my-8 sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="export-title" className="text-base font-semibold">Export {invoiceIds.length} invoice{invoiceIds.length === 1 ? "" : "s"}</h2>
            <p className="mt-1 text-xs text-ink-muted">Figures are exported as stored. Unverified invoices are marked in the status column.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100"><X className="h-4 w-4" aria-hidden /></button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
          {loadingPrefs && <p className="text-sm text-ink-muted">Loading your saved columns...</p>}

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">Format</legend>
            <label className="flex items-center gap-2 rounded-lg border border-slate-300 p-3 text-sm">
              <input type="radio" name="format" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} /> Excel (.xlsx) <span className="text-xs text-ink-muted">dates and numbers as real cells</span>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-slate-300 p-3 text-sm">
              <input type="radio" name="format" checked={format === "csv"} onChange={() => setFormat("csv")} /> CSV (.csv) <span className="text-xs text-ink-muted">plain text</span>
            </label>
          </fieldset>

          <label className="block text-sm">
            <span className="font-semibold">Layout</span>
            <select className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3" defaultValue="standard">
              {EXPORT_PROFILES.map((p) => <option key={p.id} value={p.id} disabled={p.status !== "available"}>{p.label}{p.status !== "available" ? " (planned, not available)" : ""}</option>)}
            </select>
            <span className="mt-1 block text-xs text-ink-muted">Accounting-software layouts such as Tally are not available yet.</span>
          </label>

          <label className="block text-sm">
            <span className="font-semibold">Date format</span>
            <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as "iso" | "dmy")} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3">
              <option value="iso">2026-09-15 (year-month-day, unambiguous)</option>
              <option value="dmy">15/09/2026 (day/month/year)</option>
            </select>
          </label>

          <ColumnPicker title="Invoice columns" all={INVOICE_COLUMNS} chosen={columns} onChange={setColumns} />

          <div className="space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={includeItems} onChange={(e) => setIncludeItems(e.target.checked)} className="mt-1 h-4 w-4" />
              <span><span className="font-semibold">Include line items</span><span className="block text-xs text-ink-muted">{format === "xlsx" ? "Added as a second sheet, \"Line items\"." : "One row per item, invoice columns repeated. Invoices without items keep one row."}</span></span>
            </label>
            {includeItems && <ColumnPicker title="Line item columns" all={itemCols} chosen={effectiveItemColumns} onChange={setItemColumns} />}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} className="mt-1 h-4 w-4" />
            <span><span className="font-semibold">Verified invoices only</span><span className="block text-xs text-ink-muted">Skips invoices nobody has verified yet.</span></span>
          </label>

          <div role="status" aria-live="polite">
            {error && <p className="whitespace-pre-wrap break-words rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {note && <p className="rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink">{note}</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-4">
          <div className="flex gap-2">
            <Button variant="secondary" onClick={savePrefs} loading={savingPrefs} disabled={busy || tooFew}>Save as default</Button>
            <Button variant="ghost" onClick={() => { setColumns([...DEFAULT_COLUMNS]); setItemColumns([...DEFAULT_ITEM_COLUMNS]); }} disabled={busy}>Reset</Button>
          </div>
          <Button onClick={run} loading={busy} disabled={tooFew || loadingPrefs}>
            <Download className="h-4 w-4" aria-hidden />
            {busy ? "Creating file..." : "Download"}
          </Button>
        </div>
      </div>
    </div>
  );
}
