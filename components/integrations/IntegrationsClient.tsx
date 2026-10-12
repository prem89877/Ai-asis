"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, RefreshCw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { defaultMapping, DEFAULT_SYNC_FIELDS, SYNC_FIELDS } from "@/lib/integrations/mapping";
import type { MappingEntry } from "@/lib/integrations/mapping";
import { TallyPanel } from "@/components/integrations/TallyPanel";

type Provider = "google_sheets" | "microsoft_excel";
interface Connection {
  id: string; provider: Provider; account_email: string | null; status: "active" | "needs_reauth" | "revoked";
  target: Record<string, unknown>; mapping: MappingEntry[]; date_format: "iso" | "dmy"; last_error: string | null; last_synced_at: string | null;
}
interface Recent { id: string; status: string; error_message: string | null; updated_at: string; invoices: { original_filename: string; invoice_number: string | null } | { original_filename: string; invoice_number: string | null }[] | null }
interface Overview { connections: Connection[]; recent: Recent[]; canManage: boolean; available: { google_sheets: boolean; microsoft_excel: boolean; tally: boolean } }
interface SyncResult { invoiceId: string; status: string; message?: string }

const LABEL: Record<Provider, string> = { google_sheets: "Google Sheets", microsoft_excel: "Microsoft Excel Online (OneDrive)" };
const CONNECT_ERRORS: Record<string, string> = {
  access_denied: "The sign-in was cancelled or refused.", invalid_state: "The sign-in expired. Start the connection again.", no_refresh_token: "The provider did not allow offline access. Remove AI Asis from your account's connected apps and connect again.",
  exchange_failed: "The sign-in could not be completed. Try again.", save_failed: "The connection could not be saved.", forbidden: "Only a firm owner or admin can connect an account.", signed_out: "Please log in again.", not_configured: "This integration is not configured on the server yet.", invalid_response: "The provider sent an unexpected response.",
};

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: data?.error ?? "Something went wrong. Try again." };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "Network problem. Check your connection and try again." };
  }
}

const box = "rounded-xl border border-slate-200 bg-white shadow-card";
const input = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-ink";

export function IntegrationsClient() {
  const params = useSearchParams();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Overview>("/api/integrations");
    if (r.ok) { setOverview(r.data); setLoadError(null); } else setLoadError(r.error);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const err = params.get("error");
  const connected = params.get("connected");

  if (loadError) return <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{loadError}</p>;
  if (!overview) return <p className="text-sm text-ink-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      {err && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{CONNECT_ERRORS[err] ?? "The connection failed."}</p>}
      {connected && !err && <p role="status" className="rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink">Account connected. Now choose the file below.</p>}
      {!overview.canManage && <p className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-ink-muted">You can see the status here. Only a firm owner or admin can connect accounts and sync.</p>}

      {(["google_sheets", "microsoft_excel"] as Provider[]).map((p) => (
        <ProviderCard key={p} provider={p} conn={overview.connections.find((c) => c.provider === p && c.status !== "revoked") ?? null} available={overview.available[p]} canManage={overview.canManage} onChanged={load} />
      ))}

      <TallyPanel available={overview.available.tally} />

      <section className={box} aria-labelledby="recent-sync">
        <h2 id="recent-sync" className="border-b border-slate-100 px-5 py-4 text-base font-semibold">Recent sync activity</h2>
        {overview.recent.length === 0 ? <p className="px-5 py-4 text-sm text-ink-muted">Nothing synced yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {overview.recent.map((r) => {
              const inv = Array.isArray(r.invoices) ? r.invoices[0] : r.invoices;
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span className="truncate">{inv?.invoice_number ? `${inv.invoice_number} · ` : ""}{inv?.original_filename ?? "Invoice"}</span>
                  <span className={r.status === "synced" ? "text-success-ink" : r.status === "failed" ? "text-red-700" : "text-ink-muted"}>
                    {r.status === "synced" ? "Synced" : r.status === "failed" ? `Failed: ${r.error_message ?? "unknown error"}` : "In progress"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProviderCard({ provider, conn, available, canManage, onChanged }: { provider: Provider; conn: Connection | null; available: boolean; canManage: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [results, setResults] = useState<SyncResult[] | null>(null);
  const [editing, setEditing] = useState(false);
  const configured = !!conn && Object.keys(conn.target).length > 0 && conn.mapping.length > 0;

  async function connect() {
    setBusy(true); setMsg(null);
    const r = await api<{ url: string }>(`/api/integrations/oauth/${provider}/start`, { method: "POST", body: "{}" });
    if (r.ok) window.location.assign(r.data.url);
    else { setMsg({ tone: "err", text: r.error }); setBusy(false); }
  }
  async function disconnect() {
    if (!conn || !window.confirm("Disconnect? Stored access is deleted. Already-synced rows stay in your sheet.")) return;
    setBusy(true);
    const r = await api<{ revokedAtProvider: boolean }>(`/api/integrations/connections/${conn.id}`, { method: "DELETE" });
    setMsg(r.ok ? { tone: "ok", text: provider === "google_sheets" ? (r.data.revokedAtProvider ? "Disconnected and access revoked at Google." : "Disconnected. Google could not confirm the revocation; you can also remove AI Asis at myaccount.google.com/permissions.") : "Disconnected. Microsoft cannot revoke this from outside: also remove AI Asis in your Microsoft account's app permissions." } : { tone: "err", text: r.error });
    setBusy(false); setEditing(false); await onChanged();
  }
  async function sync() {
    if (!conn) return;
    setBusy(true); setMsg(null); setResults(null);
    const r = await api<{ results: SyncResult[]; summary: Record<string, number>; message?: string }>(`/api/integrations/connections/${conn.id}/sync`, { method: "POST", body: "{}" });
    if (r.ok) {
      setResults(r.data.results);
      const s = r.data.summary;
      setMsg({ tone: (s.failed ?? 0) > 0 ? "err" : "ok", text: r.data.message ?? `${s.synced ?? 0} sent, ${s.already ?? 0} already there, ${s.duplicates ?? 0} duplicates skipped, ${s.failed ?? 0} failed.` });
    } else setMsg({ tone: "err", text: r.error });
    setBusy(false); await onChanged();
  }

  return (
    <section className={box} aria-labelledby={`h-${provider}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 id={`h-${provider}`} className="text-base font-semibold">{LABEL[provider]}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {conn ? (conn.status === "active" ? `Connected as ${conn.account_email ?? "your account"}` : "Authorization expired or revoked") : "Not connected"}
            {conn?.last_synced_at ? ` · last sync ${new Date(conn.last_synced_at).toLocaleString("en-IN")}` : ""}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {(!conn || conn.status !== "active") && <Button onClick={connect} loading={busy} disabled={!available}>{conn ? "Reconnect" : "Connect"}</Button>}
            {conn && <Button variant="secondary" onClick={disconnect} disabled={busy}><Unplug className="h-4 w-4" aria-hidden />Disconnect</Button>}
          </div>
        )}
      </div>
      <div className="space-y-4 px-5 py-4 text-sm">
        {!available && <p className="text-amber-900"><AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden />Not configured on this server yet (OAuth credentials or encryption key missing). See docs/PHASE6_PART1_SETUP.md.</p>}
        {conn?.status === "needs_reauth" && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">Your authorization expired or was revoked. Reconnect to continue syncing.</p>}
        {conn?.last_error && conn.status === "active" && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">Last problem: {conn.last_error}</p>}
        {msg && <p role="status" className={msg.tone === "ok" ? "text-success-ink" : "text-red-700"}>{msg.text}</p>}

        {conn?.status === "active" && canManage && (
          <>
            {configured && !editing ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-ink-muted">
                  Sending to <strong className="text-ink">{String(conn.target.spreadsheetName ?? conn.target.workbookName ?? "")}</strong> › {String(conn.target.worksheetTitle ?? conn.target.worksheetName ?? "")}{conn.target.tableName ? ` › table ${String(conn.target.tableName)}` : ""}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setEditing(true)}>Change file or columns</Button>
                  <Button onClick={sync} loading={busy}><RefreshCw className="h-4 w-4" aria-hidden />Sync verified invoices</Button>
                </div>
              </div>
            ) : (
              <Setup provider={provider} conn={conn} onSaved={async () => { setEditing(false); await onChanged(); }} onCancel={configured ? () => setEditing(false) : undefined} />
            )}
          </>
        )}

        {results && results.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {results.map((r) => (
              <li key={r.invoiceId} className="flex items-center gap-2 px-3 py-2">
                {r.status === "synced" || r.status === "recovered" || r.status === "already_synced" ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />}
                <span className="font-mono text-xs">{r.invoiceId.slice(0, 8)}</span>
                <span className="text-ink-muted">{r.message ?? "Sent"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Setup({ provider, conn, onSaved, onCancel }: { provider: Provider; conn: Connection; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const base = `/api/integrations/connections/${conn.id}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Google
  const [link, setLink] = useState("");
  const [sheetFile, setSheetFile] = useState<{ spreadsheetId: string; name: string; sheets: { id: number; title: string }[] } | null>(null);
  // Microsoft
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string }[] | null>(null);
  const [wb, setWb] = useState<{ id: string; name: string; worksheets: { id: string; name: string; tables: { id: string; name: string }[] }[] } | null>(null);
  // Shared
  const [choice, setChoice] = useState<{ worksheet: string; tableId: string | null } | null>(null);
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [fields, setFields] = useState<(string | null)[]>([]);
  const [dateFormat, setDateFormat] = useState<"iso" | "dmy">(conn.date_format);

  async function call<T>(body: unknown): Promise<T | null> {
    setBusy(true); setError(null);
    const r = await api<T>(`${base}/inspect`, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setError(r.error); return null; }
    return r.data;
  }
  function applyHeaders(h: string[]) {
    setHeaders(h);
    const byLabel = new Map(SYNC_FIELDS.map((f) => [f.label.toLowerCase(), f.key]));
    setFields(h.map((x) => byLabel.get(x.trim().toLowerCase()) ?? null));
  }
  async function loadHeaders(next: { worksheet: string; tableId: string | null }) {
    setChoice(next);
    const body = provider === "google_sheets" ? { action: "headers", spreadsheetId: sheetFile?.spreadsheetId, worksheetTitle: next.worksheet } : { action: "headers", itemId: wb?.id, worksheetId: next.worksheet, tableId: next.tableId };
    const d = await call<{ headers: string[] }>(body);
    if (d) applyHeaders(d.headers);
  }

  const empty = headers !== null && headers.every((h) => h.trim() === "");
  const mapping: MappingEntry[] = empty ? defaultMapping([...DEFAULT_SYNC_FIELDS]) : (headers ?? []).map((h, i) => ({ header: h, field: fields[i] ?? null }));
  const hasId = mapping.some((m) => m.field === "id");

  async function save() {
    if (!choice) return;
    setBusy(true); setError(null);
    const target = provider === "google_sheets"
      ? { spreadsheetId: sheetFile?.spreadsheetId, worksheetTitle: choice.worksheet }
      : { itemId: wb?.id, workbookName: wb?.name, worksheetId: choice.worksheet, tableId: choice.tableId };
    const r = await api(`${base}`, { method: "PATCH", body: JSON.stringify({ target, mapping, dateFormat, writeHeaders: empty }) });
    setBusy(false);
    if (!r.ok) setError(r.error); else await onSaved();
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-canvas p-4">
      <p className="font-medium">1. Choose the file</p>
      {provider === "google_sheets" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Google Sheet link" className={`${input} flex-1`} placeholder="Paste the Google Sheet link" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button variant="secondary" disabled={busy || !link.trim()} onClick={async () => { const d = await call<{ spreadsheetId: string; name: string; sheets: { id: number; title: string }[] }>({ action: "open", input: link }); if (d) { setSheetFile(d); setChoice(null); setHeaders(null); } }}>Open</Button>
            <Button variant="secondary" disabled={busy} onClick={async () => { const d = await call<{ spreadsheetId: string; name: string; sheets: { id: number; title: string }[] }>({ action: "create", name: "AI Asis invoices" }); if (d) { setSheetFile(d); setChoice(null); setHeaders(null); } }}>Create a new sheet</Button>
          </div>
          {sheetFile && (
            <label className="block">Worksheet in <strong>{sheetFile.name}</strong>
              <select className={`${input} mt-1`} value={choice?.worksheet ?? ""} onChange={(e) => e.target.value && void loadHeaders({ worksheet: e.target.value, tableId: null })}>
                <option value="">Choose…</option>
                {sheetFile.sheets.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
              </select>
            </label>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Workbook name" className={`${input} flex-1`} placeholder="Search your OneDrive for a workbook (.xlsx)" value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button variant="secondary" disabled={busy} onClick={async () => { const d = await call<{ workbooks: { id: string; name: string }[] }>({ action: "search", query }); if (d) setFiles(d.workbooks); }}>Search</Button>
          </div>
          {files && (files.length === 0 ? <p className="text-ink-muted">No .xlsx workbooks found.</p> : (
            <select aria-label="Workbook" className={input} value={wb?.id ?? ""} onChange={async (e) => { const f = files.find((x) => x.id === e.target.value); if (!f) return; const d = await call<{ worksheets: { id: string; name: string; tables: { id: string; name: string }[] }[] }>({ action: "structure", itemId: f.id }); if (d) { setWb({ id: f.id, name: f.name, worksheets: d.worksheets }); setChoice(null); setHeaders(null); } }}>
              <option value="">Choose a workbook…</option>
              {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          ))}
          {wb && (
            <label className="block">Worksheet or table in <strong>{wb.name}</strong>
              <select className={`${input} mt-1`} value={choice ? `${choice.worksheet}|${choice.tableId ?? ""}` : ""} onChange={(e) => { const [w, t] = e.target.value.split("|"); if (w) void loadHeaders({ worksheet: w, tableId: t || null }); }}>
                <option value="">Choose…</option>
                {wb.worksheets.flatMap((w) => [
                  ...w.tables.map((t) => <option key={`${w.id}|${t.id}`} value={`${w.id}|${t.id}`}>{w.name} › table {t.name} (recommended)</option>),
                  <option key={`${w.id}|`} value={`${w.id}|`}>{w.name} › whole sheet (header in row 1)</option>,
                ])}
              </select>
            </label>
          )}
        </div>
      )}

      {headers && (
        <>
          <p className="font-medium">2. Map the columns</p>
          {empty ? (
            <p className="text-ink-muted">This sheet is empty. AI Asis will write a header row with {mapping.length} standard columns (including AI Asis ID) when you save.</p>
          ) : (
            <div className="space-y-2">
              {headers.map((h, i) => (
                <label key={i} className="grid items-center gap-2 sm:grid-cols-2">
                  <span className="truncate">{h || <em className="text-ink-muted">(blank column)</em>}</span>
                  <select aria-label={`Invoice field for column ${h}`} className={input} value={fields[i] ?? ""} onChange={(e) => setFields((f) => f.map((v, j) => (j === i ? e.target.value || null : v)))}>
                    <option value="">Leave empty</option>
                    {SYNC_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                </label>
              ))}
              {!hasId && <p className="text-amber-900">Map one column to <strong>AI Asis ID</strong>. It is how duplicates are avoided.</p>}
            </div>
          )}
          <label className="block">Date format
            <select className={`${input} mt-1 max-w-xs`} value={dateFormat} onChange={(e) => setDateFormat(e.target.value === "dmy" ? "dmy" : "iso")}>
              <option value="iso">2026-09-15</option>
              <option value="dmy">15/09/2026</option>
            </select>
          </label>
        </>
      )}

      {error && <p role="alert" className="text-red-700">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save} loading={busy} disabled={!choice || !headers || !hasId}>Save</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}
