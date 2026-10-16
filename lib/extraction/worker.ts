// Server-side extraction worker: claims queued jobs and runs them WITHOUT a browser.
// Used by /api/invoices/[id]/extract (one invoice, the browser asked for it) and by /api/cron/extraction (a scheduler asks, nobody has to
// keep a tab open). SERVER ONLY: it needs the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCheckConfig, getFxConfig, getLimits } from "./config.ts";
import type { GeminiConfig } from "./config.ts";
import { createFxLookup } from "./fx-rates.ts";
import { callGemini } from "./gemini.ts";
import { createGstPortalLookup } from "./gst-portal.ts";
import { runExtraction } from "./pipeline.ts";
import type { RunResult } from "./pipeline.ts";
import { createSupabaseFiles, createSupabaseFxCache, createSupabaseStore } from "./store.ts";

export interface ClaimResult {
  result: "claimed" | "not_found" | "no_job" | "already_processing" | "not_queued" | "busy";
  job_id?: string;
  storage_path?: string;
  mime_type?: string;
  sha256?: string;
}

// Moves the queued job of one invoice to 'processing' (atomic, per-firm concurrency limit). null = the call itself failed.
export async function claimJob(admin: SupabaseClient, invoiceId: string, firmId: string): Promise<ClaimResult | null> {
  const limits = getLimits();
  const { data, error } = await admin.rpc("claim_extraction_job", {
    p_invoice_id: invoiceId,
    p_firm_id: firmId,
    p_max_concurrent: limits.maxConcurrent,
    p_stale_seconds: limits.staleSeconds,
  });
  if (error || !data) {
    console.error("claim_failed", { invoiceId, code: error?.code ?? null });
    return null;
  }
  return data as ClaimResult;
}

export function isFullClaim(c: ClaimResult): c is Required<Pick<ClaimResult, "job_id" | "storage_path" | "mime_type" | "sha256">> & ClaimResult {
  return c.result === "claimed" && !!c.job_id && !!c.storage_path && !!c.mime_type && !!c.sha256;
}

// Runs the extraction for a job that was claimed. The job is always closed by runExtraction (completed / needs_review / failed).
export async function runClaimedJob(admin: SupabaseClient, geminiConfig: GeminiConfig, claim: ClaimResult, ctx: { invoiceId: string; firmId: string; userId: string | null }): Promise<RunResult> {
  const limits = getLimits();
  const fxConfig = getFxConfig();
  return runExtraction(
    {
      store: createSupabaseStore(admin),
      files: createSupabaseFiles(admin),
      gemini: callGemini,
      geminiConfig,
      checkConfig: getCheckConfig(),
      gstPortal: createGstPortalLookup(),
      fx: fxConfig.enabled ? createFxLookup({ cache: createSupabaseFxCache(admin), timeoutMs: fxConfig.timeoutMs }) : null,
      maxPdfPages: limits.maxPdfPages,
    },
    { jobId: claim.job_id as string, invoiceId: ctx.invoiceId, firmId: ctx.firmId, userId: ctx.userId, storagePath: claim.storage_path as string, mime: claim.mime_type as string, sha256: claim.sha256 as string },
  );
}

export interface WorkerOptions {
  maxJobs?: number; // how many queued jobs one cycle starts (they run in parallel)
  minAgeSeconds?: number; // leave a just-queued job to the browser that queued it
}

export interface WorkerSummary {
  reaped: number;
  listed: number;
  started: number;
  skipped: number;
  outcomes: Record<string, number>;
}

interface QueuedRow { job_id: string; invoice_id: string; firm_id: string; requested_by: string | null }

// One worker cycle: (1) fail stale jobs of every firm, (2) take the oldest queued jobs (fair between firms) and run them.
// Every job is claimed atomically, so a browser /extract call racing with this worker simply gets "not queued" for that invoice.
export async function runWorkerCycle(admin: SupabaseClient, geminiConfig: GeminiConfig, options: WorkerOptions = {}): Promise<WorkerSummary> {
  const limits = getLimits();
  const maxJobs = Math.max(0, Math.min(options.maxJobs ?? limits.maxConcurrent, 20));
  const summary: WorkerSummary = { reaped: 0, listed: 0, started: 0, skipped: 0, outcomes: {} };

  const reaped = await admin.rpc("reap_stale_extraction_jobs", { p_stale_seconds: limits.staleSeconds });
  if (reaped.error) console.error("worker_reap_failed", { code: reaped.error.code ?? null });
  else summary.reaped = Number(reaped.data ?? 0);

  if (maxJobs === 0) return summary;
  const listed = await admin.rpc("list_queued_extraction_jobs", { p_limit: maxJobs, p_min_age_seconds: options.minAgeSeconds ?? 15 });
  if (listed.error) {
    console.error("worker_list_failed", { code: listed.error.code ?? null });
    return summary;
  }
  const rows = (listed.data ?? []) as QueuedRow[];
  summary.listed = rows.length;

  await Promise.all(
    rows.map(async (row) => {
      try {
        const claim = await claimJob(admin, row.invoice_id, row.firm_id);
        if (!claim || !isFullClaim(claim)) {
          summary.skipped += 1; // busy (firm at its concurrency limit), taken by the browser, or the invoice was removed
          return;
        }
        summary.started += 1;
        const result = await runClaimedJob(admin, geminiConfig, claim, { invoiceId: row.invoice_id, firmId: row.firm_id, userId: row.requested_by });
        summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
      } catch {
        console.error("worker_job_failed", { invoiceId: row.invoice_id });
        summary.outcomes.error = (summary.outcomes.error ?? 0) + 1;
      }
    }),
  );
  return summary;
}
