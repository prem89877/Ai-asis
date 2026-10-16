"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Download, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS, INVOICE_COLUMNS, ITEM_COLUMNS } from "@/lib/export/columns";
import { DEFAULT_TALLY_CONFIG } from "@/lib/tally/build";
import type { TallyConfig } from "@/lib/tally/build";

interface Props {
  invoiceIds: string[];
  onClose: () => void;
  /** Called after a file was created and handed to the browser. */
  onExported: (message: { ok: boolean; text: string }) => void;
}

type Fmt = "xlsx" | "csv";
type Layout = "standard" | "tally";
type TallyFmt = "xml" | "json" | "csv";
interface TallySkip { invoiceId: string; invoiceNumber: string | null; reason: string }
const TALLY_KEY = "ai-asis-tally-ledgers";
const TALLY_LABELS: [keyof TallyConfig, string][] = [["voucherType", "Voucher type"], ["purchaseLedger", "Purchase ledger"], ["cgstLedger", "CGST ledger"], ["sgstLedger", "SGST ledger"], ["utgstLedger", "UTGST ledger"], ["igstLedger", "IGST ledger"], ["cessLedger", "Cess ledger"], ["roundOffLedger", "Round-off ledger"], ["tcsLedger", "TCS ledger"], ["chargesLedger", "Freight / packing ledger"], ["discountLedger", "Discount ledger"], ["companyName", "Tally company (optional)"]];

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
  // The finished export is a normal link to the server (GET /api/exports/:id/download). A link the person taps is always
  // a normal download. Script-made blob downloads were blocked by some Android browsers after the first one.
  const [result, setResult] = useState<{ href: string; name: string; text: string; fallback: boolean; blob?: boolean } | null>(null);
  // Tally: the ledger names start with common defaults, and the last names you used are remembered in this browser,
  // so after the first time exporting is a single tap.
  const [layout, setLayout] = useState<Layout>("standard");
  const [tallyFormat, setTallyFormat] = useState<TallyFmt>("xml");
  const [tallyCfg, setTallyCfg] = useState<TallyConfig>({ ...DEFAULT_TALLY_CONFIG });
  const [tallySkipped, setTallySkipped] = useState<TallySkip[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TALLY_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<TallyConfig>;
      setTallyCfg((c) => {
        const next = { ...c };
        for (const k of Object.keys(DEFAULT_TALLY_CONFIG) as (keyof TallyConfig)[]) if (typeof saved[k] === "string") next[k] = saved[k] as string;
        return next;
      });
    } catch { /* storage unavailable or damaged: the defaults stay */ }
  }, []);

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
    // The new tab must be opened right inside the tap (before any await), otherwise popup blockers stop it.
    // Each download then happens in a fresh tab, which browsers do not throttle. The tab is pointed at the file below.
    const win = window.open("", "_blank");
    setBusy(true);
    setError(null);
    setNote(null);
    setResult(null);
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
        win?.close();
        // `detail` is only ever sent by a local debug server (AI_ASIS_DEBUG_ERRORS=1); production never includes it.
        setError(`${body.error ?? "The export could not be created. Try again."}${body.detail ? `\nDETAIL: ${body.detail}` : ""}`);
        setBusy(false);
        return;
      }
      const out = (await res.json()) as { id: string; fileName: string; count: number; skipped: number; unverified: number };
      const parts = [`${out.fileName} is ready with ${out.count} invoice${out.count === 1 ? "" : "s"}.`];
      if (out.skipped > 0) parts.push(`${out.skipped} skipped (not extracted yet${verifiedOnly ? " or not verified" : ""}).`);
      if (out.unverified > 0) parts.push(`${out.unverified} not yet verified. Review them before using the figures.`);
      const text = parts.join(" ");
      const href = `/api/exports/${out.id}/download`;
      setResult({ href, name: out.fileName, text, fallback: !win });
      if (win) {
        win.location.href = href;
        // The file arrives as a download, so the new tab itself stays blank. Close it shortly after the download has
        // started; the browser then returns to this page. (A tab opened by a script may be closed by that script.)
        setTimeout(() => {
          try { win.close(); } catch { /* the browser keeps it open; nothing to do */ }
        }, 2500);
      }
      setBusy(false);
      onExported({ ok: true, text });
    } catch {
      win?.close();
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function runTally() {
    setBusy(true);
    setError(null);
    setNote(null);
    setResult(null);
    setTallySkipped([]);
    try {
      const res = await fetch("/api/exports/tally", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: tallyFormat, config: tallyCfg, invoiceIds }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; content?: string; fileName?: string; contentType?: string; count?: number; skipped?: TallySkip[] } | null;
      if (res.status === 404) { setError("Tally export is turned off on this server."); setBusy(false); return; }
      if (!res.ok || !data?.content) {
        setError(data?.error ?? "The Tally file could not be created. Try again.");
        setTallySkipped(data?.skipped ?? []);
        setBusy(false);
        return;
      }
      try { window.localStorage.setItem(TALLY_KEY, JSON.stringify(tallyCfg)); } catch { /* not remembered; nothing else is affected */ }
      const name = data.fileName ?? `ai-asis-tally.${tallyFormat}`;
      const href = URL.createObjectURL(new Blob([data.content], { type: data.contentType ?? "text/plain" }));
      const a = document.createElement("a");
      a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      const skipped = data.skipped ?? [];
      const text = `${name} is ready with ${data.count} voucher${data.count === 1 ? "" : "s"}.${skipped.length > 0 ? ` ${skipped.length} invoice${skipped.length === 1 ? "" : "s"} skipped, see below.` : ""}`;
      setResult({ href, name, text, fallback: true, blob: true });
      setTallySkipped(skipped);
      setBusy(false);
      onExported({ ok: true, text });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
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

          <label className="block text-sm">
            <span className="font-semibold">Export as</span>
            <select value={layout} onChange={(e) => { setLayout(e.target.value as Layout); setError(null); setResult(null); }} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3">
              <option value="standard">Standard (Excel / CSV)</option>
              <option value="tally">Tally (purchase vouchers) - experimental</option>
            </select>
          </label>

          {layout === "tally" && (
            <div className="space-y-4">
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                Only <strong>verified</strong> invoices are exported, one purchase voucher each. The supplier name is used as the party ledger. Nothing is sent to Tally: you get a file to import. This format has not been tried in Tally yet, so import it into a <strong>test company</strong> first.
              </p>
              <details className="rounded-lg border border-slate-200 p-3">
                <summary className="cursor-pointer text-sm font-semibold">Ledger names (already filled in)</summary>
                <p className="mt-2 text-xs text-ink-muted">Change them only if your Tally ledgers have different names. They must match Tally exactly. Your last names are remembered on this device.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {TALLY_LABELS.map(([k, l]) => (
                    <label key={k} className="block text-sm">{l}
                      <input className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm" value={tallyCfg[k]} onChange={(e) => setTallyCfg((c) => ({ ...c, [k]: e.target.value }))} />
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="text-sm">File type
                    <select value={tallyFormat} onChange={(e) => setTallyFormat(e.target.value as TallyFmt)} className="ml-2 h-10 rounded-lg border border-slate-300 bg-white px-3">
                      <option value="xml">XML (for Tally import)</option><option value="json">JSON</option><option value="csv">CSV</option>
                    </select>
                  </label>
                  <Button variant="ghost" onClick={() => setTallyCfg({ ...DEFAULT_TALLY_CONFIG })} disabled={busy}>Use default names</Button>
                </div>
              </details>
            </div>
          )}

          {layout === "standard" && (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold">Format</legend>
            <label className="flex items-center gap-2 rounded-lg border border-slate-300 p-3 text-sm">
              <input type="radio" name="format" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} /> Excel (.xlsx) <span className="text-xs text-ink-muted">dates and numbers as real cells</span>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-slate-300 p-3 text-sm">
              <input type="radio" name="format" checked={format === "csv"} onChange={() => setFormat("csv")} /> CSV (.csv) <span className="text-xs text-ink-muted">plain text</span>
            </label>
          </fieldset>
          )}

          {layout === "standard" && (
          <>
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

          </>
          )}

          <div role="status" aria-live="polite">
            {error && <p className="whitespace-pre-wrap break-words rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {note && <p className="rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink">{note}</p>}
          </div>
          {tallySkipped.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
              {tallySkipped.slice(0, 15).map((x) => <li key={x.invoiceId}>{x.invoiceNumber ?? x.invoiceId.slice(0, 8)}: {x.reason}</li>)}
              {tallySkipped.length > 15 && <li>and {tallySkipped.length - 15} more</li>}
            </ul>
          )}
        </div>

        {result && (
          <div role="status" className="space-y-3 border-t border-emerald-300 bg-success-soft p-4 text-sm text-success-ink">
            <p>{result.text}</p>
            <p className="text-xs">{result.blob ? "The file should download by itself. If nothing happened, tap the button below." : result.fallback ? "Your browser blocked the new tab. Tap the button below to download." : "The file is downloading. The extra tab closes by itself and brings you back here."}</p>
            <div className="flex flex-wrap gap-2">
              {result.fallback && (
                <a href={result.href} {...(result.blob ? { download: result.name } : { target: "_blank", rel: "noopener noreferrer" })} className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white">
                <Download className="h-4 w-4" aria-hidden />Download {result.name}
              </a>
              )}
              <Button variant="secondary" onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-4">
          <div className="flex gap-2">
            {layout === "standard" && (
              <>
                <Button variant="secondary" onClick={savePrefs} loading={savingPrefs} disabled={busy || tooFew}>Save as default</Button>
                <Button variant="ghost" onClick={() => { setColumns([...DEFAULT_COLUMNS]); setItemColumns([...DEFAULT_ITEM_COLUMNS]); }} disabled={busy}>Reset</Button>
              </>
            )}
          </div>
          <Button onClick={layout === "tally" ? runTally : run} loading={busy} disabled={layout === "tally" ? false : tooFew || loadingPrefs}>
            <Download className="h-4 w-4" aria-hidden />
            {busy ? "Creating file..." : layout === "tally" ? "Export to Tally" : "Download"}
          </Button>
        </div>
      </div>
    </div>
  );
}
