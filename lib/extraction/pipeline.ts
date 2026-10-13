// Orchestrates one extraction run for one claimed job:
// download -> verify -> preflight -> Gemini (retries, timeouts) -> validate -> normalize -> checks -> save.
// Everything outside this file (database, storage, provider) is injected, so it can be tested without network.
import { createHash } from "node:crypto";
import { runChecks, outcomeFor } from "./checks.ts";
import { validateInvoice } from "./gst-engine.ts";
import type { ExtractionErrorCode } from "./errors.ts";
import { estimateCostUsd } from "./gemini.ts";
import type { GeminiCaller, GeminiCallResult } from "./gemini.ts";
import { getCheckConfig } from "./config.ts";
import type { CheckConfig, GeminiConfig } from "./config.ts";
import { nameKey, normalizeExtraction } from "./normalize.ts";
import { preflight } from "./preflight.ts";
import { buildVerifyUserPrompt, VERIFY_SYSTEM_PROMPT } from "./prompt.ts";
import { validateModelOutput } from "./schema.ts";
import { reconcile, recheckFlags } from "./verify.ts";
import type { JobOutcome, ModelOutput, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export interface UsageRecordInput {
  firmId: string;
  userId: string | null;
  invoiceId: string;
  jobId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  outcome: string;
}

export interface DuplicateQuery {
  firmId: string;
  invoiceId: string;
  invoiceNumberNorm: string | null;
  vendorGstin: string | null;
  invoiceDate: string | null;
  totalAmount: number | null;
}

export interface DuplicateCandidate {
  invoiceId: string;
  vendorGstin: string | null;
  vendorName: string | null;
  matchedBy: "number" | "fingerprint";
}

export interface CompleteArgs {
  jobId: string;
  firmId: string;
  outcome: JobOutcome;
  extracted: StoredExtracted | null;
  items: StoredItem[];
  attempts: number;
  errorCode: ExtractionErrorCode | null;
}

export type CompleteResult = "ok" | "not_processing" | "not_found" | "invoice_removed";

export interface ExtractionStore {
  recordUsage(r: UsageRecordInput): Promise<void>;
  findDuplicateCandidates(q: DuplicateQuery): Promise<DuplicateCandidate[]>;
  complete(a: CompleteArgs): Promise<CompleteResult>;
}

export interface FileSource {
  download(path: string): Promise<Uint8Array | null>;
}

export interface PipelineDeps {
  store: ExtractionStore;
  files: FileSource;
  gemini: GeminiCaller;
  geminiConfig: GeminiConfig;
  checkConfig?: CheckConfig;
  maxPdfPages: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: typeof fetch;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface RunContext {
  jobId: string;
  invoiceId: string;
  firmId: string;
  userId: string | null;
  storagePath: string;
  mime: string;
  sha256: string;
}

export interface RunResult {
  outcome: JobOutcome;
  errorCode: ExtractionErrorCode | null;
  attempts: number;
  flagCount: number;
  costUsd: number;
}

const MIN_TIME_FOR_CALL_MS = 5_000;
const MIN_TIME_FOR_RETRY_MS = 8_000;
// The second check only starts if this much of the run budget is left, and always leaves a margin for saving.
const MIN_TIME_FOR_VERIFY_MS = 12_000;
const VERIFY_SAVE_MARGIN_MS = 4_000;

function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stripFence(text)) };
  } catch {
    return { ok: false };
  }
}

function supplierCompatible(e: StoredExtracted, c: DuplicateCandidate): boolean {
  if (e.vendor_gstin && c.vendorGstin) return e.vendor_gstin === c.vendorGstin;
  const a = nameKey(e.vendor_name);
  const b = nameKey(c.vendorName);
  if (a && b) return a === b;
  return true; // supplier unknown on one side: cannot rule a duplicate out
}

export function duplicateFlag(e: StoredExtracted, candidates: DuplicateCandidate[]): ReviewFlag | null {
  const hits = candidates.filter((c) => c.matchedBy === "fingerprint" || supplierCompatible(e, c));
  if (hits.length === 0) return null;
  return {
    code: "possible_duplicate",
    severity: "warning",
    message: "Another invoice in this firm has the same invoice number and supplier, or the same supplier, date and total.",
    details: { invoiceIds: Array.from(new Set(hits.map((h) => h.invoiceId))).slice(0, 10) },
  };
}

export async function runExtraction(deps: PipelineDeps, ctx: RunContext): Promise<RunResult> {
  const cfg = deps.geminiConfig;
  const checkCfg = deps.checkConfig ?? getCheckConfig({});
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((event, data) => console.error(event, data));
  const started = now();

  let attempts = 0;
  let costUsd = 0;

  const fail = async (code: ExtractionErrorCode): Promise<RunResult> => {
    try {
      await deps.store.complete({ jobId: ctx.jobId, firmId: ctx.firmId, outcome: "failed", extracted: null, items: [], attempts, errorCode: code });
    } catch {
      log("extraction_fail_save_error", { jobId: ctx.jobId, code });
    }
    return { outcome: "failed", errorCode: code, attempts, flagCount: 0, costUsd };
  };

  const recordUsage = async (res: GeminiCallResult, label: string) => {
    const usage = res.usage;
    const cost = usage ? estimateCostUsd(usage, cfg.inputPricePerMTok, cfg.outputPricePerMTok) : null;
    if (cost) costUsd += cost;
    try {
      await deps.store.recordUsage({
        firmId: ctx.firmId,
        userId: ctx.userId,
        invoiceId: ctx.invoiceId,
        jobId: ctx.jobId,
        model: cfg.model,
        inputTokens: usage ? usage.inputTokens : null,
        outputTokens: usage ? usage.outputTokens : null,
        costUsd: cost,
        outcome: label,
      });
    } catch {
      log("extraction_usage_save_error", { jobId: ctx.jobId });
    }
  };

  try {
    const bytes = await deps.files.download(ctx.storagePath);
    if (!bytes) return await fail("file_missing");
    if (createHash("sha256").update(bytes).digest("hex") !== ctx.sha256) return await fail("file_integrity");

    const pre = preflight(bytes, { expectedMime: ctx.mime, maxPdfPages: deps.maxPdfPages });
    if (!pre.ok) return await fail(pre.code);

    let model: ModelOutput | null = null;
    let lastCode: ExtractionErrorCode = "provider_timeout";

    while (attempts < cfg.maxAttempts) {
      const remaining = cfg.deadlineMs - (now() - started);
      if (remaining < MIN_TIME_FOR_CALL_MS) break;
      attempts += 1;

      const res = await deps.gemini({
        apiKey: cfg.apiKey,
        model: cfg.model,
        mime: ctx.mime,
        data: bytes,
        timeoutMs: Math.max(1_000, Math.min(cfg.timeoutMs, remaining - 1_000)),
        maxOutputTokens: cfg.maxOutputTokens,
        fetchImpl: deps.fetchImpl,
      });

      let retryAfterMs: number | undefined;
      if (res.ok) {
        const parsed = parseModelJson(res.text);
        const validated = parsed.ok ? validateModelOutput(parsed.value) : null;
        if (validated && validated.ok) {
          await recordUsage(res, "ok");
          model = validated.data;
          break;
        }
        lastCode = "invalid_model_output";
        // Log field paths only, never values.
        log("extraction_invalid_output", { jobId: ctx.jobId, attempt: attempts, errors: validated && !validated.ok ? validated.errors.slice(0, 5) : ["not_json"] });
        await recordUsage(res, "invalid_model_output");
      } else {
        lastCode = res.code;
        retryAfterMs = res.retryAfterMs;
        log("extraction_provider_error", { jobId: ctx.jobId, attempt: attempts, code: res.code, status: res.httpStatus ?? null });
        await recordUsage(res, res.code);
        if (!res.retryable) break;
      }

      if (attempts >= cfg.maxAttempts) break;
      const backoff = Math.min(retryAfterMs ?? 1_000 * 2 ** (attempts - 1), 8_000) + Math.floor(random() * 250);
      const left = cfg.deadlineMs - (now() - started) - backoff;
      if (left < MIN_TIME_FOR_RETRY_MS) break;
      await sleep(backoff);
    }

    if (!model) return await fail(lastCode);
    if (model.document_type === "not_an_invoice") return await fail("not_an_invoice");

    // ---- Second layer: the model reads the same document again, the two readings are compared in code. ----
    // If this step fails for any reason the first reading is used as it is and a note is added.
    const recheckNotes: ReviewFlag[] = [];
    let agreed: ReadonlySet<string> | undefined;
    if (cfg.verify) {
      const remaining = cfg.deadlineMs - (now() - started);
      if (remaining < MIN_TIME_FOR_VERIFY_MS) {
        recheckNotes.push({ code: "recheck_unavailable", severity: "info", message: "The second check was skipped because time ran out. Only one reading of the document was used." });
      } else {
        try {
          const res = await deps.gemini({
            apiKey: cfg.apiKey,
            model: cfg.model,
            mime: ctx.mime,
            data: bytes,
            timeoutMs: Math.max(1_000, Math.min(cfg.timeoutMs, remaining - VERIFY_SAVE_MARGIN_MS)),
            maxOutputTokens: cfg.maxOutputTokens,
            fetchImpl: deps.fetchImpl,
            systemPrompt: VERIFY_SYSTEM_PROMPT,
            userPrompt: buildVerifyUserPrompt(model),
          });
          const parsed = res.ok ? parseModelJson(res.text) : null;
          const second = parsed && parsed.ok ? validateModelOutput(parsed.value) : null;
          if (res.ok && second && second.ok) {
            await recordUsage(res, "verify_ok");
            if (second.data.document_type === "not_an_invoice") {
              recheckNotes.push({ code: "recheck_mismatch", severity: "warning", field: "document_type", message: "The second check thought this file is not an invoice. Check the original.", details: { first: model.document_type, second: "not_an_invoice" } });
            } else {
              const rec = reconcile(model, second.data, checkCfg);
              model = rec.merged;
              agreed = rec.agreed;
              recheckNotes.push(...recheckFlags(rec));
            }
          } else {
            await recordUsage(res, res.ok ? "verify_invalid_output" : `verify_${res.code}`);
            log("extraction_recheck_unavailable", { jobId: ctx.jobId, code: res.ok ? "invalid_model_output" : res.code });
            recheckNotes.push({ code: "recheck_unavailable", severity: "info", message: "The second check could not run. Only one reading of the document was used." });
          }
        } catch {
          log("extraction_recheck_error", { jobId: ctx.jobId });
          recheckNotes.push({ code: "recheck_unavailable", severity: "info", message: "The second check could not run. Only one reading of the document was used." });
        }
      }
    }

    const { extracted, items } = normalizeExtraction(model, { model: cfg.model, now: new Date(now()), agreed });
    const flags: ReviewFlag[] = [...extracted.review_flags, ...runChecks(extracted, items, checkCfg), ...recheckNotes];

    // GST validation engine verdict: saved with the invoice. A difference of up to INR 2.00 between the calculated and the
    // printed grand total is recorded as round_off_amount (source "computed"), so the original figures are never changed.
    const verdict = validateInvoice({ extracted, items }, { tolerancePaise: checkCfg.tolerancePaise });
    extracted.validation_summary = verdict.summary as unknown as Record<string, unknown>;
    if (verdict.patch.round_off_amount !== undefined) {
      extracted.round_off_amount = Math.round(verdict.patch.round_off_amount * 100) / 100;
      extracted.field_status.round_off_amount = { state: "value", confidence: 1, source: "computed" };
    }

    try {
      const candidates = await deps.store.findDuplicateCandidates({
        firmId: ctx.firmId,
        invoiceId: ctx.invoiceId,
        invoiceNumberNorm: extracted.invoice_number_norm,
        vendorGstin: extracted.vendor_gstin,
        invoiceDate: extracted.invoice_date,
        totalAmount: extracted.total_amount,
      });
      const dup = duplicateFlag(extracted, candidates);
      if (dup) flags.push(dup);
    } catch {
      log("extraction_duplicate_check_error", { jobId: ctx.jobId });
      flags.push({ code: "duplicate_check_unavailable", severity: "warning", message: "The duplicate check could not run. Check manually for duplicates." });
    }

    extracted.review_flags = flags;
    const outcome = outcomeFor(flags);
    const saved = await deps.store.complete({ jobId: ctx.jobId, firmId: ctx.firmId, outcome, extracted, items, attempts, errorCode: null });
    if (saved !== "ok") {
      log("extraction_complete_rejected", { jobId: ctx.jobId, result: saved });
      return { outcome: "failed", errorCode: saved === "invoice_removed" ? "invoice_removed" : "stale_timeout", attempts, flagCount: flags.length, costUsd };
    }
    return { outcome, errorCode: null, attempts, flagCount: flags.length, costUsd };
  } catch (err) {
    log("extraction_unexpected_error", { jobId: ctx.jobId, name: err instanceof Error ? err.name : "unknown" });
    return await fail("internal_error");
  }
}
