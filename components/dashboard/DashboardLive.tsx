"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, LayoutDashboard, LogOut, Settings } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { signOutAction } from "@/lib/auth/actions";
import { MAX_UPLOAD_MB } from "@/lib/invoices/validation";
import type { Activity, Stat } from "@/lib/sample-data";
import type { JobRow, Summary } from "@/lib/review/client-types";
import { StatCards } from "./StatCards";
import { RecentActivity } from "./RecentActivity";
import { UploadDropzone } from "./UploadDropzone";
import { InvoiceReviewTable } from "./InvoiceReviewTable";
import { UsagePanel } from "./UsagePanel";
import { ExportDialog } from "./ExportDialog";
import { ReviewWorkspace } from "@/components/review/ReviewWorkspace";

interface DashboardLiveProps {
  displayName: string;
  firmName: string;
  /** Counts and usage loaded on the server. null = could not be loaded (shown as an error, never as zeros). */
  summary: Summary | null;
  summaryError: boolean;
  monthlyLimit: number;
  jobs: JobRow[];
  activity: Activity[];
  /** Server-side batch limit, passed down so the UI can warn early. The server enforces it. */
  maxBatchFiles: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const EXTRACT_CONCURRENCY = 2;

const nav = [
  { label: "Dashboard", icon: LayoutDashboard, current: true },
  { label: "Invoices", icon: FileText, current: false },
  { label: "Settings", icon: Settings, current: false },
];

export function DashboardLive({ displayName, firmName, summary: initialSummary, summaryError: initialSummaryError, monthlyLimit, jobs, activity, maxBatchFiles }: DashboardLiveProps) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [summary, setSummary] = useState<Summary | null>(initialSummary);
  const [summaryError, setSummaryError] = useState(initialSummaryError);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [reviewNeighbors, setReviewNeighbors] = useState<string[]>([]);

  // Server props change after router.refresh(); keep the local copy in step.
  useEffect(() => {
    setSummary(initialSummary);
    setSummaryError(initialSummaryError);
  }, [initialSummary, initialSummaryError]);

  const reloadSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/review/summary", { cache: "no-store" });
      const body = (await res.json()) as { summary?: Summary };
      if (res.ok && body.summary) {
        setSummary(body.summary);
        setSummaryError(false);
      } else setSummaryError(true);
    } catch {
      setSummaryError(true);
    }
  }, []);

  // One call refreshes the table, the counts and the server-rendered panels.
  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void reloadSummary();
    router.refresh();
  }, [reloadSummary, router]);

  const stats: Stat[] = [
    { label: "Invoices", value: summary ? String(summary.total) : "-", hint: "All uploaded files" },
    { label: "Needs review", value: summary ? String(summary.needs_review) : "-", hint: summary ? `${summary.needs_review_flagged} with warnings` : "Waiting for a person" },
    { label: "Verified", value: summary ? String(summary.verified) : "-", hint: "Checked by a person" },
    { label: "Processing", value: summary ? String(summary.processing) : "-", hint: "Queued or being read" },
    { label: "Failed", value: summary ? String(summary.failed) : "-", hint: "Could not be processed" },
    { label: "Processed this month", value: summary ? String(summary.month_succeeded) : "-", hint: "AI extractions that finished" },
  ];

  async function postJson(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  }

  // Runs extraction for one queued invoice. A 429 means the server is busy: wait and retry.
  async function extractOne(id: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(`/api/invoices/${id}/extract`, { method: "POST" });
        const data = (await res.json().catch(() => ({}))) as { status?: string; message?: string | null; error?: string };
        if (res.status === 429) {
          await sleep(3000);
          continue;
        }
        if (res.ok) return { ok: true, status: data.status, error: data.message ?? undefined };
        return { ok: false, error: data.error ?? "Processing failed." };
      } catch {
        return { ok: false, error: "Network error." };
      }
    }
    return { ok: false, error: "The server is busy. Use Extract to try again." };
  }

  async function processIds(ids: string[]) {
    const queue = [...ids];
    const tally = { completed: 0, needs_review: 0, failed: 0 };
    const errors: string[] = [];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const r = await extractOne(id);
        if (r.ok && r.status === "completed") tally.completed += 1;
        else if (r.ok && r.status === "needs_review") tally.needs_review += 1;
        else {
          tally.failed += 1;
          if (r.error) errors.push(r.error);
        }
        refreshAll();
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, ids.length) }, worker));
    const summary = `Extraction finished: ${tally.completed} completed, ${tally.needs_review} need review, ${tally.failed} failed. AI-extracted data is not verified.`;
    setMessage({ ok: tally.failed === 0, text: [summary, ...Array.from(new Set(errors))].join(" ") });
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    if (files.length > maxBatchFiles) {
      setMessage({ ok: false, text: `You can upload up to ${maxBatchFiles} files at a time.` });
      return;
    }
    setUploading(true);
    setMessage(null);

    const batch = await postJson("/api/invoices/batches", { fileCount: files.length }).catch(() => null);
    if (!batch || !batch.res.ok) {
      setUploading(false);
      setMessage({ ok: false, text: (batch?.data.error as string | undefined) ?? "Network error. Try again." });
      return;
    }
    const batchId = batch.data.batchId as string;

    const uploadedIds: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        errors.push(`${file.name}: larger than ${MAX_UPLOAD_MB} MB`);
        continue;
      }
      const body = new FormData();
      body.append("file", file);
      body.append("batch_id", batchId);
      try {
        const res = await fetch("/api/invoices/upload", { method: "POST", body });
        const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (res.ok && data.id) uploadedIds.push(data.id);
        else errors.push(`${file.name}: ${data.error ?? "upload failed"}`);
      } catch {
        errors.push(`${file.name}: network error`);
      }
    }
    setUploading(false);
    refreshAll();

    if (uploadedIds.length === 0) {
      setMessage({ ok: false, text: errors.join(" ") || "Nothing was uploaded." });
      return;
    }

    setExtracting(true);
    try {
      const queued = await postJson("/api/invoices/enqueue", { invoiceIds: uploadedIds });
      if (!queued.res.ok) {
        setMessage({ ok: false, text: [`${uploadedIds.length} uploaded.`, (queued.data.error as string | undefined) ?? "Could not queue extraction.", ...errors].join(" ") });
        refreshAll();
        return;
      }
      const ids = ((queued.data.enqueued ?? []) as { invoiceId: string }[]).map((e) => e.invoiceId);
      refreshAll();
      await processIds(ids);
      if (errors.length > 0) setMessage((m) => ({ ok: false, text: [m?.text ?? "", ...errors].join(" ") }));
    } catch {
      setMessage({ ok: false, text: "Network error while queuing extraction." });
    } finally {
      setExtracting(false);
      refreshAll();
    }
  }

  // Row action: queue first when the invoice is not queued yet (uploaded or failed), then run it.
  async function extractRow(id: string, status: string) {
    setBusyId(id);
    setExtracting(true);
    setMessage(null);
    try {
      if (status !== "queued") {
        const queued = await postJson("/api/invoices/enqueue", { invoiceIds: [id] });
        const enq = (queued.data.enqueued ?? []) as unknown[];
        if (!queued.res.ok || enq.length === 0) {
          const skipped = (queued.data.skipped ?? []) as { reason: string }[];
          const reason = skipped[0]?.reason === "max_runs_reached" ? "This invoice has reached its retry limit." : undefined;
          setMessage({ ok: false, text: (queued.data.error as string | undefined) ?? reason ?? "This invoice cannot be queued right now." });
          return;
        }
        refreshAll();
      }
      await processIds([id]);
    } catch {
      setMessage({ ok: false, text: "Network error. Try again." });
    } finally {
      setBusyId(null);
      setExtracting(false);
      refreshAll();
    }
  }

  async function downloadFile(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invoices/${id}/download`);
      const data = (await res.json()) as { url?: string; error?: string };
      if (res.ok && data.url) window.location.assign(data.url);
      else setMessage({ ok: false, text: data.error ?? "The file is not available." });
    } catch {
      setMessage({ ok: false, text: "Network error. Try again." });
    }
    setBusyId(null);
  }

  async function deleteFile(id: string) {
    if (!window.confirm("Delete this invoice and its file permanently?")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/invoices/${id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMessage(res.ok ? { ok: true, text: "Invoice deleted." } : { ok: false, text: data.error ?? "Could not delete." });
      if (res.ok) setSelected((cur) => { const n = new Set(cur); n.delete(id); return n; });
    } catch {
      setMessage({ ok: false, text: "Network error. Try again." });
    }
    setBusyId(null);
    refreshAll();
  }

  async function logout() {
    await signOutAction();
    router.replace("/login");
    refreshAll();
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
        <Logo />
        <nav aria-label="Dashboard" className="mt-4 flex gap-1 overflow-x-auto lg:flex-col">
          {nav.map(({ label, icon: Icon, current }) => (
            <span key={label} aria-current={current ? "page" : undefined} className={cn("flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium", current ? "bg-brand-soft text-brand" : "text-ink-muted")}>
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </span>
          ))}
        </nav>
      </aside>

      <main className="p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="mt-1 text-sm text-ink-muted">{displayName} · {firmName}</p>
          </div>
          <Button variant="secondary" onClick={logout}>
            <LogOut className="h-4 w-4" aria-hidden />
            Log out
          </Button>
        </div>

        <div role="status" aria-live="polite" className="mt-4">
          {message && (
            <p className={message.ok ? "rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink" : "rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"}>
              {message.text}
            </p>
          )}
        </div>

        <div className="mt-6 space-y-6">
          {summaryError && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <span>The dashboard counts could not be loaded. If you just updated the app, check that the Phase 4 database migration has been run.</span>
              <Button variant="secondary" onClick={() => void reloadSummary()}>Try again</Button>
            </div>
          )}
          <StatCards stats={stats} />
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <InvoiceReviewTable
              summary={summary}
              refreshKey={refreshKey}
              selected={selected}
              onSelectedChange={setSelected}
              busyId={busyId}
              onReview={(id, pageIds) => { setReviewNeighbors(pageIds); setViewId(id); }}
              onExtract={extractRow}
              onDownload={downloadFile}
              onDelete={deleteFile}
              onExport={() => setExporting(true)}
              onPolled={reloadSummary}
            />
            <div className="space-y-6">
              <UploadDropzone onFilesSelected={uploadFiles} busy={uploading || extracting} hint={`PDF, JPG or PNG, up to ${MAX_UPLOAD_MB} MB each, ${maxBatchFiles} files per batch. AI-extracted data must be reviewed before use.`} />
              <UsagePanel summary={summary} monthlyLimit={monthlyLimit} jobs={jobs} />
              <RecentActivity items={activity} />
            </div>
          </div>
        </div>
      </main>
      {viewId && (
        <ReviewWorkspace
          invoiceId={viewId}
          neighborIds={reviewNeighbors}
          onNavigate={setViewId}
          onClose={() => setViewId(null)}
          onChanged={refreshAll}
          onOpenOriginal={downloadFile}
        />
      )}
      {exporting && (
        <ExportDialog
          invoiceIds={Array.from(selected)}
          onClose={() => setExporting(false)}
          onExported={(m) => {
            // The dialog stays open so the person can tap the download link again if the browser blocked the first one.
            setMessage(m);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}
