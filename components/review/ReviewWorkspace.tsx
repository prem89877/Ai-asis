"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FileText, Info, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ReviewStatusBadge } from "@/components/ui/ReviewStatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDay, formatInr } from "@/lib/format";
import { DOCUMENT_TYPE_LABEL, EDITABLE_DOCUMENT_TYPES, HEADER_FIELDS, ITEM_FIELDS, MAX_ITEMS } from "@/lib/review/fields";
import type { HeaderColumn, ItemColumn } from "@/lib/review/fields";
import { checkHeaderDraft, checkItemsDraft, countIssues } from "@/lib/review/draft-check";
import type { DraftIssue, HeaderIssues, ItemIssues } from "@/lib/review/draft-check";

interface FieldMeta { state: string; confidence: number; autoCorrected?: { from: string; to: string } }
interface Flag { code: string; severity: "error" | "warning" | "info"; field?: string; itemPosition?: number; message: string }
interface Duplicate { id: string; original_filename: string; invoice_number: string | null; vendor_name: string | null; invoice_date: string | null; total_amount: number | null; status: string }
interface Loaded {
  invoice: { original_filename: string; status: string; mime_type: string };
  extracted: (Record<string, unknown> & { review_flags: Flag[]; field_status: Record<string, FieldMeta>; corrected_fields: Record<string, { original: string | number | null }>; updated_at: string; verified_at: string | null; confidence: number | null }) | null;
  items: (Record<string, unknown> & { field_status: Record<string, FieldMeta> })[];
  duplicates: Duplicate[];
  job: { status: string; error_code: string | null; error_message: string | null } | null;
}

type HeaderDraft = Record<HeaderColumn, string>;
type ItemDraft = Record<ItemColumn, string>;

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const flagStyle = {
  error: { icon: AlertCircle, cls: "border-red-300 bg-red-50 text-red-900" },
  warning: { icon: AlertTriangle, cls: "border-amber-300 bg-amber-50 text-amber-900" },
  info: { icon: Info, cls: "border-slate-200 bg-slate-50 text-slate-700" },
} as const;

// A few extraction flags carry no field name. They are still shown next to the box they are about.
const HEADER_FLAG_FALLBACK: Record<string, string> = {
  possible_duplicate: "invoice_number",
  tax_on_bill_of_supply: "document_type",
  invoice_tax_rate_mismatch: "taxable_value",
  tax_allocation_mismatch: "igst",
  supplier_gstin_cancelled: "supplier_gstin",
  supplier_gstin_not_yet_registered: "supplier_gstin",
  supplier_gstin_inactive: "supplier_gstin",
  supplier_gstin_blocked: "supplier_gstin",
  composition_charging_tax: "supplier_gstin",
};
const ITEM_FLAG_FALLBACK: Record<string, string> = { arithmetic_line_mismatch: "taxable_value", negative_line_suspect: "taxable_value" };

interface Props {
  invoiceId: string;
  neighborIds: string[];
  onNavigate: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
  onOpenOriginal: (id: string) => void;
}

export function ReviewWorkspace({ invoiceId, neighborIds, onNavigate, onClose, onChanged, onOpenOriginal }: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [header, setHeader] = useState<HeaderDraft | null>(null);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [itemSrc, setItemSrc] = useState<(number | null)[]>([]); // original position of each row (null = added here); keeps line labels on the right row
  const [baseline, setBaseline] = useState("");
  const [tab, setTab] = useState<"preview" | "details">("details");
  const [busy, setBusy] = useState<null | "save" | "verify" | "unverify">(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmVerify, setConfirmVerify] = useState<Flag[] | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setData(null);
    setLoadError(null);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/extraction`, { cache: "no-store" });
      const body = (await res.json()) as Loaded & { error?: string };
      if (!res.ok) {
        setLoadError(body.error ?? "Could not load this invoice.");
        return;
      }
      setData(body);
      const e = body.extracted;
      if (e) {
        const h = {} as HeaderDraft;
        for (const f of HEADER_FIELDS) h[f.column] = str(e[f.column]);
        const it = body.items.map((r) => {
          const d = {} as ItemDraft;
          for (const f of ITEM_FIELDS) d[f.key] = str(r[f.key]);
          return d;
        });
        setHeader(h);
        setItems(it);
        setItemSrc(it.map((_, n) => n + 1));
        setBaseline(JSON.stringify({ h, it }));
      }
    } catch {
      setLoadError("Network error. Check your connection and try again.");
    }
  }, [invoiceId]);

  useEffect(() => {
    setMessage(null);
    setConfirmVerify(null);
    void load();
  }, [load, version]);

  const dirty = header !== null && JSON.stringify({ h: header, it: items }) !== baseline;
  const itemsDirty = useMemo(() => {
    if (!baseline) return false;
    return JSON.stringify(items) !== JSON.stringify((JSON.parse(baseline) as { it: ItemDraft[] }).it);
  }, [items, baseline]);

  // What the person typed (boxes that differ from the saved value): checked live, shown next to the box, separate from the AI flags.
  const baseDraft = useMemo(() => (baseline ? (JSON.parse(baseline) as { h: HeaderDraft; it: ItemDraft[] }) : null), [baseline]);
  const manualHeader = useMemo<HeaderIssues>(() => (header && baseDraft ? checkHeaderDraft(header, baseDraft.h) : {}), [header, baseDraft]);
  const manualItems = useMemo<ItemIssues[]>(() => (baseDraft ? checkItemsDraft(items, baseDraft.it, header?.currency ?? "") : []), [items, baseDraft, header?.currency]);
  const manualCount = useMemo(() => countIssues(manualHeader, manualItems), [manualHeader, manualItems]);

  const tryClose = useCallback(() => {
    if (dirty && !window.confirm("You have unsaved changes. Close without saving?")) return;
    onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && tryClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tryClose]);

  const idx = neighborIds.indexOf(invoiceId);
  const go = (to: string | undefined) => {
    if (!to) return;
    if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    onNavigate(to);
  };

  const flags = data?.extracted?.review_flags ?? [];
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sortedFlags = [...flags].sort((a, b) => order[a.severity] - order[b.severity]);
  const flagsByField = new Map<string, Flag[]>();
  for (const f of flags) {
    const key = f.field ?? HEADER_FLAG_FALLBACK[f.code];
    if (key && !f.itemPosition) flagsByField.set(key, [...(flagsByField.get(key) ?? []), f]);
  }

  async function submit(action: "save" | "verify" | "unverify", acknowledge = false) {
    if (!data?.extracted || !header) return;
    setBusy(action);
    setMessage(null);
    const body: Record<string, unknown> = { expectedUpdatedAt: data.extracted.updated_at, action, acknowledgeFlags: acknowledge };
    if (action !== "unverify") {
      const h: Record<string, string> = {};
      for (const f of HEADER_FIELDS) if (header[f.column] !== "" || f.kind !== "doctype") h[f.column] = header[f.column];
      body.header = h;
      if (itemsDirty) { body.items = items; body.itemSources = itemSrc; }
    }
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/review`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = (await res.json().catch(() => ({}))) as { error?: string; code?: string; flags?: Flag[] };
      if (res.status === 409 && out.code === "needs_acknowledgement") {
        setConfirmVerify((out.flags ?? []).filter((f) => f.severity !== "info"));
      } else if (!res.ok) {
        setMessage({ ok: false, text: out.error ?? "Could not save. Try again." });
        if (out.code === "conflict") setMessage({ ok: false, text: `${out.error} Your edits are still on screen; copy anything you need before reloading.` });
      } else {
        setConfirmVerify(null);
        setMessage({ ok: true, text: action === "verify" ? "Marked as verified." : action === "unverify" ? "Verification removed." : "Changes saved. Flags were re-checked." });
        onChanged();
        await load();
      }
    } catch {
      setMessage({ ok: false, text: "Network error. Nothing was saved." });
    }
    setBusy(null);
  }

  const setH = (c: HeaderColumn, v: string) => setHeader((h) => (h ? { ...h, [c]: v } : h));
  const setItem = (i: number, c: ItemColumn, v: string) => setItems((list) => list.map((r, n) => (n === i ? { ...r, [c]: v } : r)));
  const addItem = () => { if (items.length >= MAX_ITEMS) return; setItems((l) => [...l, Object.fromEntries(ITEM_FIELDS.map((f) => [f.key, ""])) as ItemDraft]); setItemSrc((s) => [...s, null]); };
  const delItem = (i: number) => { setItems((l) => l.filter((_, n) => n !== i)); setItemSrc((s) => s.filter((_, n) => n !== i)); };

  const verified = data?.invoice.status === "verified";
  const canEdit = !!data?.extracted && ["completed", "needs_review", "verified"].includes(data.invoice.status);
  const isPdf = data?.invoice.mime_type === "application/pdf";
  const fileUrl = `/api/invoices/${invoiceId}/file`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 id="review-title" className="truncate text-base font-semibold">{data?.invoice.original_filename ?? "Invoice"}</h2>
          <div className="mt-0.5 flex items-center gap-2">{data && <ReviewStatusBadge status={data.invoice.status} />}</div>
        </div>
        {neighborIds.length > 1 && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => go(neighborIds[idx - 1])} disabled={idx <= 0} aria-label="Previous invoice" className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronLeft className="h-4 w-4" aria-hidden /></button>
            <span className="text-xs text-ink-muted">{idx + 1}/{neighborIds.length}</span>
            <button type="button" onClick={() => go(neighborIds[idx + 1])} disabled={idx < 0 || idx >= neighborIds.length - 1} aria-label="Next invoice" className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronRight className="h-4 w-4" aria-hidden /></button>
          </div>
        )}
        <button type="button" onClick={tryClose} aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-slate-100"><X className="h-4 w-4" aria-hidden /></button>
      </header>

      <div role="tablist" aria-label="Show" className="flex border-b border-slate-200 bg-white lg:hidden">
        {(["details", "preview"] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 py-3 text-sm font-medium ${tab === t ? "border-b-2 border-brand text-brand" : "text-ink-muted"}`}>
            {t === "details" ? "Extracted fields" : "Original invoice"}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        {/* Original invoice */}
        <section aria-label="Original invoice" className={`${tab === "preview" ? "flex" : "hidden"} min-h-0 flex-col bg-slate-100 lg:flex`}>
          <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-ink-muted">
            <span>Original file. Compare every figure with it.</span>
            <button type="button" onClick={() => onOpenOriginal(invoiceId)} className="inline-flex items-center gap-1 font-medium text-brand"><ExternalLink className="h-3.5 w-3.5" aria-hidden />Download</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!data ? (
              <Skeleton className="h-full min-h-[300px] w-full" />
            ) : isPdf ? (
              <>
                {/* Android browsers cannot show a PDF inside a page, so phones get an Open button instead. */}
                <object data={fileUrl} type="application/pdf" className="hidden h-full min-h-[480px] w-full rounded bg-white lg:block" aria-label="Original PDF">
                  <PdfFallback url={fileUrl} />
                </object>
                <div className="lg:hidden"><PdfFallback url={fileUrl} /></div>
              </>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl} alt={`Original invoice ${data.invoice.original_filename}`} className="mx-auto h-auto max-w-full rounded bg-white" />
            )}
          </div>
        </section>

        {/* Extracted fields */}
        <section aria-label="Extracted fields" className={`${tab === "details" ? "flex" : "hidden"} min-h-0 flex-col bg-white lg:flex`}>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5">
            {loadError && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
                {loadError} <button type="button" className="font-semibold underline" onClick={() => setVersion((v) => v + 1)}>Try again</button>
              </div>
            )}
            {!data && !loadError && <div className="space-y-3" aria-busy="true">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}

            {data?.job?.status === "failed" && (
              <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">Extraction failed: {data.job.error_message ?? "unknown error"}. Go back and use Retry.</p>
            )}
            {data && !data.extracted && data.job?.status !== "failed" && (
              <p className="flex items-center gap-2 text-sm text-ink-muted"><FileText className="h-4 w-4" aria-hidden />No extracted data yet. It appears here when processing finishes.</p>
            )}

            {data?.extracted && header && (
              <>
                {message && (
                  <p role="status" className={message.ok ? "rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink" : "rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"}>{message.text}</p>
                )}
                {verified && data.extracted.verified_at && <p className="flex items-center gap-2 text-sm text-success-ink"><CheckCircle2 className="h-4 w-4" aria-hidden />Verified. Editing will remove the verification.</p>}

                {sortedFlags.length > 0 && (
                  <section aria-labelledby="flags-title">
                    <h3 id="flags-title" className="text-sm font-semibold">Warnings ({sortedFlags.length})</h3>
                    <p className="mt-0.5 text-xs text-ink-muted">{flags.some((x) => x.code === "line_item_auto_corrected") ? "A misread line-item value was corrected automatically because the invoice maths proves it (the AI's original value is in the note). Check each against the original." : flags.some((x) => x.code === "gstin_auto_corrected") ? "Only a GSTIN check digit was fixed automatically (you can switch back below). Check each against the original." : "Nothing was changed automatically. Check each against the original."}</p>
                    <ul className="mt-2 space-y-2">
                      {sortedFlags.map((f, i) => {
                        const { icon: Icon, cls } = flagStyle[f.severity];
                        return (
                          <li key={`${f.code}-${i}`} className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${cls}`}>
                            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                            <span>{f.itemPosition ? `Item ${f.itemPosition}: ` : ""}{f.message}</span>
                          </li>
                        );
                      })}
                    </ul>
                    {data.duplicates.length > 0 && (
                      <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                        <p className="font-medium text-amber-900">Possible duplicates of this invoice</p>
                        <ul className="mt-1 space-y-1">
                          {data.duplicates.map((d) => (
                            <li key={d.id}>
                              <button type="button" onClick={() => go(d.id)} className="text-left text-brand underline">
                                {[d.vendor_name, d.invoice_number, formatDay(d.invoice_date), d.total_amount !== null ? formatInr(d.total_amount) : null].filter(Boolean).join(" · ") || d.original_filename}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                )}

                {canEdit && (
                  <>
                    <section aria-labelledby="fields-title">
                      <h3 id="fields-title" className="text-sm font-semibold">Invoice fields</h3>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {HEADER_FIELDS.map((f) => {
                          const meta = data.extracted?.field_status[f.statusKey];
                          const fieldFlags = flagsByField.get(f.statusKey) ?? [];
                          const corrected = data.extracted?.corrected_fields[f.column];
                          const low = !corrected && meta && (meta.state === "value" || meta.state === "zero") && meta.confidence < 0.8;
                          const manual = manualHeader[f.column] ?? [];
                          const edited = !!baseDraft && header[f.column] !== baseDraft.h[f.column];
                          const aiNotes = fieldFlags.filter((x) => x.severity !== "info");
                          const tone = manual.some((m) => m.severity === "error") || (!edited && aiNotes.some((x) => x.severity === "error")) ? "error" : manual.length > 0 || (!edited && aiNotes.length > 0) || low ? "warning" : null;
                          const id = `f-${f.column}`;
                          return (
                            <div key={f.column} className={f.column === "vendor_name" || f.column === "buyer_name" ? "sm:col-span-2" : undefined}>
                              <label htmlFor={id} className="block text-xs font-medium text-ink-muted">{f.label}</label>
                              {f.kind === "doctype" ? (
                                <select id={id} value={header[f.column]} onChange={(e) => setH(f.column, e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">
                                  {!header[f.column] && <option value="">Choose</option>}
                                  {EDITABLE_DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABEL[t]}</option>)}
                                </select>
                              ) : (
                                <input
                                  id={id}
                                  type={f.kind === "date" ? "date" : "text"}
                                  inputMode={f.kind === "amount" || f.kind === "rate" ? "decimal" : undefined}
                                  autoCapitalize={f.kind === "gstin" || f.kind === "currency" ? "characters" : undefined}
                                  autoComplete="off"
                                  maxLength={f.kind === "gstin" ? 15 : f.kind === "currency" ? 3 : f.maxLength}
                                  value={header[f.column]}
                                  onChange={(e) => setH(f.column, e.target.value)}
                                  aria-invalid={tone ? true : undefined}
                                  className={`mt-1 h-11 w-full rounded-lg border bg-white px-3 text-sm ${f.kind === "amount" || f.kind === "rate" ? "tabular-nums" : ""} ${toneClass(tone)}`}
                                />
                              )}
                              <FieldNotes ai={aiNotes} manual={manual} edited={edited} />
                              {f.kind === "gstin" && meta?.autoCorrected && (() => {
                                const ac = meta.autoCorrected;
                                const showingRaw = header[f.column] === ac.from;
                                return (
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                                    <span className={`rounded-full px-2 py-0.5 font-medium ${showingRaw ? "bg-slate-100 text-ink-muted" : "bg-success-soft text-success-ink"}`}>
                                      {showingRaw ? "Raw extracted GSTIN (checksum fails)" : "GSTIN Auto-Corrected (Checksum Fixed)"}
                                    </span>
                                    <button type="button" onClick={() => setH(f.column, showingRaw ? ac.to : ac.from)} className="text-brand underline">
                                      {showingRaw ? "Use validated GSTIN" : "Use raw extracted GSTIN"}
                                    </button>
                                    <span className="w-full text-ink-muted">Raw: {ac.from} · Validated: {ac.to}</span>
                                  </div>
                                );
                              })()}
                              {meta?.state === "missing" && !header[f.column] && <p className="mt-1 text-xs text-ink-muted">Not found on the document.</p>}
                              {meta?.state === "unreadable" && !header[f.column] && <p className="mt-1 text-xs text-amber-800">Unreadable. Enter it from the original.</p>}
                              {low && <p className="mt-1 text-xs text-amber-800">Read with low confidence.</p>}
                              {corrected && <p className="mt-1 text-xs text-ink-muted">Edited. AI read: {corrected.original === null || corrected.original === "" ? "(blank)" : String(corrected.original)}</p>}
                            </div>
                          );
                        })}
                      </div>
                      {data.extracted.confidence !== null && <p className="mt-2 text-xs text-ink-muted">Model-reported confidence: {Math.round(Number(data.extracted.confidence) * 100)}%. This is the model&apos;s own estimate, not a measured accuracy.</p>}
                    </section>

                    <section aria-labelledby="items-title">
                      <div className="flex items-center justify-between">
                        <h3 id="items-title" className="text-sm font-semibold">Line items ({items.length})</h3>
                        <Button variant="secondary" onClick={addItem} disabled={items.length >= MAX_ITEMS}><Plus className="h-4 w-4" aria-hidden />Add item</Button>
                      </div>
                      {items.length === 0 && <p className="mt-2 text-sm text-ink-muted">No line items were extracted.</p>}
                      <ol className="mt-2 space-y-3">
                        {items.map((row, i) => {
                          const itemFlags = flags.filter((f) => f.itemPosition === i + 1 && f.severity !== "info");
                          const flagKey = (f: Flag) => f.field ?? ITEM_FLAG_FALLBACK[f.code];
                          const unkeyed = itemFlags.filter((f) => !ITEM_FIELDS.some((d) => d.statusKey === flagKey(f)));
                          const manualRow = manualItems[i] ?? {};
                          const hasManual = Object.values(manualRow).some((a) => (a ?? []).length > 0);
                          return (
                            <li key={i} className={`rounded-lg border p-3 ${itemFlags.length || hasManual ? "border-amber-400" : "border-slate-200"}`}>
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">Item {i + 1}</span>
                                <button type="button" onClick={() => delItem(i)} aria-label={`Remove item ${i + 1}`} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" aria-hidden /></button>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {ITEM_FIELDS.map((f) => {
                                  const manual = manualRow[f.key] ?? [];
                                  const baseRow = baseDraft?.it[i];
                                  const edited = baseRow ? row[f.key] !== baseRow[f.key] : row[f.key] !== "";
                                  const ai = itemFlags.filter((x) => flagKey(x) === f.statusKey);
                                  const tone = manual.some((m) => m.severity === "error") || (!edited && ai.some((x) => x.severity === "error")) ? "error" : manual.length > 0 || (!edited && ai.length > 0) ? "warning" : null;
                                  return (
                                    <div key={f.key} className={f.key === "description" ? "col-span-2 sm:col-span-3" : undefined}>
                                      <label htmlFor={`i${i}-${f.key}`} className="block text-xs text-ink-muted">{f.label}</label>
                                      <input id={`i${i}-${f.key}`} type="text" autoComplete="off" aria-invalid={tone ? true : undefined} inputMode={f.kind === "amount" ? "decimal" : f.kind === "hsn" ? "numeric" : undefined} value={row[f.key]} onChange={(e) => setItem(i, f.key, e.target.value)} className={`mt-0.5 h-10 w-full rounded-lg border bg-white px-2 text-sm ${f.kind === "amount" ? "tabular-nums" : ""} ${toneClass(tone)}`} />
                                      <FieldNotes ai={ai} manual={manual} edited={edited} compact />
                                    </div>
                                  );
                                })}
                              </div>
                              {unkeyed.length > 0 && <ul className="mt-2 space-y-1 text-xs text-amber-900">{unkeyed.map((f, n) => <li key={n}>{f.message}</li>)}</ul>}
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  </>
                )}
              </>
            )}
          </div>

          {canEdit && data?.extracted && (
            <footer className="border-t border-slate-200 bg-white p-3 sm:px-5" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
              {confirmVerify && (
                <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alertdialog" aria-label="Confirm verification">
                  <p className="font-medium">{confirmVerify.length} open warning{confirmVerify.length === 1 ? "" : "s"} remain. Verify anyway?</p>
                  <p className="mt-0.5 text-xs">Verifying says you checked this invoice against the original and accept these points. Your choice is recorded.</p>
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => submit("verify", true)} loading={busy === "verify"}>Verify anyway</Button>
                    <Button variant="secondary" onClick={() => setConfirmVerify(null)} disabled={busy !== null}>Cancel</Button>
                  </div>
                </div>
              )}
              {manualCount.errors > 0 ? (
                <p role="alert" className="mb-2 flex items-start gap-2 text-sm text-red-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Fix the {manualCount.errors} red entr{manualCount.errors === 1 ? "y" : "ies"} marked &quot;Your entry&quot; before saving.</p>
              ) : manualCount.warnings > 0 ? (
                <p className="mb-2 flex items-start gap-2 text-sm text-amber-900"><Pencil className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{manualCount.warnings} value{manualCount.warnings === 1 ? "" : "s"} you typed look{manualCount.warnings === 1 ? "s" : ""} wrong. Check the marked boxes. You can still save.</p>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {verified && !dirty && <Button variant="secondary" onClick={() => submit("unverify")} loading={busy === "unverify"} disabled={busy !== null}>Remove verification</Button>}
                <Button variant="secondary" onClick={() => submit("save")} loading={busy === "save"} disabled={!dirty || busy !== null || manualCount.errors > 0}>Save changes</Button>
                {(!verified || dirty) && (
                  <Button onClick={() => (dirty ? submitVerifyAfterSave() : submit("verify"))} loading={busy === "verify"} disabled={busy !== null || manualCount.errors > 0}>
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    {dirty ? "Save and verify" : "Mark as verified"}
                  </Button>
                )}
              </div>
            </footer>
          )}
        </section>
      </div>
    </div>
  );

  // "Save and verify" sends the edits and the verification in one request, so they are checked together.
  function submitVerifyAfterSave() {
    void submit("verify");
  }
}

function toneClass(tone: "error" | "warning" | null): string {
  return tone === "error" ? "border-red-500 ring-1 ring-red-300" : tone === "warning" ? "border-amber-500 ring-1 ring-amber-300" : "border-slate-300";
}

// Messages right under a box. Two kinds, labelled differently:
//  "Invoice check"  = what the extraction checks found about the value the AI read (shown dimmed once the box is edited, because it
//                     described the old value; everything is re-checked on save);
//  "Your entry"     = what looks wrong in the text the person typed (live, before saving).
function FieldNotes({ ai, manual, edited, compact }: { ai: Flag[]; manual: DraftIssue[]; edited: boolean; compact?: boolean }) {
  if (ai.length === 0 && manual.length === 0) return null;
  const size = compact ? "text-[11px]" : "text-xs";
  return (
    <ul className={`mt-1 space-y-1 ${size}`} aria-live="polite">
      {ai.map((f, n) => {
        const { icon: Icon, cls } = flagStyle[f.severity];
        return (
          <li key={`ai-${f.code}-${n}`} className={`flex items-start gap-1.5 rounded-md border px-2 py-1 ${cls} ${edited ? "opacity-60" : ""}`}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span><b className="font-semibold">{edited ? "Invoice check (before your edit): " : "Invoice check: "}</b>{f.message}</span>
          </li>
        );
      })}
      {manual.map((m, n) => (
        <li key={`me-${n}`} className={`flex items-start gap-1.5 rounded-md border px-2 py-1 ${m.severity === "error" ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span><b className="font-semibold">Your entry: </b>{m.message}</span>
        </li>
      ))}
    </ul>
  );
}

function PdfFallback({ url }: { url: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-white p-6 text-center">
      <FileText className="h-8 w-8 text-ink-muted" aria-hidden />
      <p className="text-sm text-ink-muted">This browser cannot show the PDF inside the page.</p>
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white">
        <ExternalLink className="h-4 w-4" aria-hidden />Open original PDF
      </a>
    </div>
  );
}
