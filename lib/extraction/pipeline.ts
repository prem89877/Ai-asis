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
import { resolveForex } from "./forex.ts";
import type { ForexResult } from "./forex.ts";
import type { FxLookup } from "./fx-rates.ts";
import { checkSupplierOnPortal } from "./gst-portal.ts";
import type { GstLookup } from "./gst-portal.ts";
import { reconcileLineItems } from "./line-fix.ts";
import { nameKey, normalizeExtraction } from "./normalize.ts";
import { preflight } from "./preflight.ts";
import { buildDynamicPrompt, composeSystemPrompt } from "./dynamic-prompt.ts";
import type { DocumentSignals, DynamicPrompt } from "./dynamic-prompt.ts";
import { AUDIT_SYSTEM_PROMPT, AUDIT_USER_PROMPT, buildVerifyUserPrompt, KEYFIGURES_SYSTEM_PROMPT, KEYFIGURES_USER_PROMPT, PARTIES_SYSTEM_PROMPT, PARTIES_USER_PROMPT, SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from "./prompt.ts";
import { buildKeyFiguresSchema, buildPartiesSchema, validateKeyFigures, validateModelOutput, validateParties } from "./schema.ts";
import { auditExtraction, needsAnotherPartiesReading } from "./final-audit.ts";
import { resolveParties } from "./party-check.ts";
import type { GstinVerdict } from "./party-check.ts";
import { resolveGrandTotal } from "./total-check.ts";
import type { GrandTotalVerdict, ReadingTotal } from "./total-check.ts";
import { reconcile, reconcileMany, recheckFlags } from "./verify.ts";
import type { Reconciled } from "./verify.ts";
import type { JobOutcome, KeyFigures, ModelOutput, PartiesReading, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

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
  gstPortal?: GstLookup | null; // live GST portal lookup of the supplier GSTIN (gst-portal.ts); null / absent = not configured
  fx?: FxLookup | null; // historical exchange rate of the invoice date for foreign currency invoices (fx-rates.ts); null / absent = off
  maxPdfPages: number;
  promptBuilder?: (signals: DocumentSignals) => DynamicPrompt; // dynamic-prompt.ts; replaceable in tests. Used only when geminiConfig.dynamicPrompt is on.
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

// What the grand-total cross-check found, kept with the invoice (validation_summary.total_consensus).
function totalSummary(v: GrandTotalVerdict | null, layers: number): Record<string, unknown> {
  if (!v || v.status === "no_value") return {};
  const final = v.candidates.find((c) => v.field !== null && c.value === v.field.value);
  return {
    total_consensus: {
      status: v.status,
      witnesses: v.witnessCount,
      sources: final ? final.witnesses : [],
      readings: layers,
      words_value: v.wordsValue,
      words_match: v.wordsMatch,
    },
  };
}

// Short, storable form of a GSTIN verdict (validation_summary.verification.gstin).
function gstinSummary(v: GstinVerdict): Record<string, unknown> {
  return { status: v.status, vote: v.vote, witnesses: v.witnesses, readings: v.readings, agreeing: v.agreeing, evidence: v.evidence, problems: v.problems, read_as: v.distinct.length > 1 ? v.distinct : undefined };
}

// Every full reading in order: first, then the second and audit readings that were usable.
function readingsForParties(first: ModelOutput, extra: { data: ModelOutput }[]): ModelOutput[] {
  return [first, ...extra.map((x) => x.data)];
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

      // First reading only. The fixed system prompt stays; a short invoice-specific section is added to it. If the engine fails
      // for any reason the run continues with the unchanged static prompts (the model never sees a half-built prompt).
      let promptOverride: { systemPrompt: string; userPrompt: string } | null = null;
      if (cfg.dynamicPrompt) {
        try {
          const dyn = (deps.promptBuilder ?? buildDynamicPrompt)({
            mime: ctx.mime,
            pages: pre.pages,
            width: pre.width,
            height: pre.height,
            attempt: attempts,
            previousFailure: attempts > 1 ? lastCode : null,
          });
          promptOverride = { systemPrompt: composeSystemPrompt(SYSTEM_PROMPT, dyn), userPrompt: dyn.userPrompt };
        } catch {
          log("extraction_dynamic_prompt_error", { jobId: ctx.jobId });
        }
      }

      const res = await deps.gemini({
        apiKey: cfg.apiKey,
        model: cfg.model,
        mime: ctx.mime,
        data: bytes,
        timeoutMs: Math.max(1_000, Math.min(cfg.timeoutMs, remaining - 1_000)),
        maxOutputTokens: cfg.maxOutputTokens,
        fetchImpl: deps.fetchImpl,
        ...(promptOverride ?? {}),
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

    // ---- Further layers. Everything below is compared in plain code; the model never decides a final value. ----
    //   second reading : sees the first reading as data that may be wrong and re-reads the whole document (EXTRACTION_VERIFY)
    //   audit reading  : blind, row by row, the three full readings are voted field by field (EXTRACTION_AUDIT)
    //   key figures    : blind, small: totals block, e-invoice identifiers, amount in words (EXTRACTION_TOTAL_CHECK)
    // They run at the same time, so the run takes about as long as one extra reading. If a layer fails for any reason the
    // others are still used and a note says which one is missing.
    const recheckNotes: ReviewFlag[] = [];
    let agreed: ReadonlySet<string> | undefined;
    let verdict: GrandTotalVerdict | null = null;
    let layerCount = 1;
    const firstReading: ModelOutput = model;
    const wantSecond = cfg.verify;
    const wantAudit = !!cfg.audit;
    const wantKey = !!cfg.totalCheck;
    const wantParties = !!cfg.partiesCheck;
    const extraFull: { name: "second" | "audit"; data: ModelOutput }[] = [];
    let keyFigures: KeyFigures | null = null;
    const parties: PartiesReading[] = [];
    let verdicts: { supplier_gstin: GstinVerdict; buyer_gstin: GstinVerdict } | null = null;

    if (wantSecond || wantAudit || wantKey || wantParties) {
      const remaining = cfg.deadlineMs - (now() - started);
      if (remaining < MIN_TIME_FOR_VERIFY_MS) {
        recheckNotes.push({ code: "recheck_unavailable", severity: "info", message: "The second check was skipped because time ran out. Only one reading of the document was used." });
      } else {
        const timeoutMs = Math.max(1_000, Math.min(cfg.timeoutMs, remaining - VERIFY_SAVE_MARGIN_MS));
        const call = async (extra: { systemPrompt: string; userPrompt: string; responseSchema?: unknown }): Promise<GeminiCallResult | null> => {
          try {
            return await deps.gemini({ apiKey: cfg.apiKey, model: cfg.model, mime: ctx.mime, data: bytes, timeoutMs, maxOutputTokens: cfg.maxOutputTokens, fetchImpl: deps.fetchImpl, ...extra });
          } catch {
            return null;
          }
        };
        const [secondRes, auditRes, keyRes, partiesRes] = await Promise.all([
          wantSecond ? call({ systemPrompt: VERIFY_SYSTEM_PROMPT, userPrompt: buildVerifyUserPrompt(firstReading) }) : Promise.resolve(undefined),
          wantAudit ? call({ systemPrompt: AUDIT_SYSTEM_PROMPT, userPrompt: AUDIT_USER_PROMPT }) : Promise.resolve(undefined),
          wantKey ? call({ systemPrompt: KEYFIGURES_SYSTEM_PROMPT, userPrompt: KEYFIGURES_USER_PROMPT, responseSchema: buildKeyFiguresSchema() }) : Promise.resolve(undefined),
          wantParties ? call({ systemPrompt: PARTIES_SYSTEM_PROMPT, userPrompt: PARTIES_USER_PROMPT, responseSchema: buildPartiesSchema() }) : Promise.resolve(undefined),
        ]);

        // One blind parties reading (supplier / buyer, GSTIN, PAN, state, every printed GSTIN): parse, record usage, keep it if usable.
        const takeParties = async (res: GeminiCallResult | null | undefined, usageLabel: string): Promise<boolean> => {
          if (res === undefined) return false;
          if (res === null) {
            log("extraction_parties_error", { jobId: ctx.jobId });
            return false;
          }
          const parsed = res.ok ? parseModelJson(res.text) : null;
          const checked = parsed && parsed.ok ? validateParties(parsed.value) : null;
          if (res.ok && checked && checked.ok) {
            await recordUsage(res, `${usageLabel}_ok`);
            parties.push(checked.data);
            return true;
          }
          await recordUsage(res, res.ok ? `${usageLabel}_invalid_output` : `${usageLabel}_${res.code}`);
          log("extraction_parties_unavailable", { jobId: ctx.jobId, code: res.ok ? "invalid_model_output" : res.code });
          return false;
        };
        if (partiesRes !== undefined && !(await takeParties(partiesRes, "parties"))) {
          recheckNotes.push({ code: "parties_unavailable", severity: "info", message: "The supplier / buyer reading (GSTIN, PAN, state) could not run, so one witness fewer was used for the GSTINs." });
        }

        // One full reading (second or audit): parse, record usage, keep it if it is a usable invoice reading.
        const takeFull = async (name: "second" | "audit", res: GeminiCallResult | null | undefined) => {
          if (res === undefined) return;
          const prefix = name === "second" ? "verify" : "audit";
          const unavailable = () =>
            recheckNotes.push(
              name === "second"
                ? { code: "recheck_unavailable", severity: "info", message: "The second check could not run. Only one reading of the document was used." }
                : { code: "audit_unavailable", severity: "info", message: "The detailed audit reading could not run, so one reading fewer was used to cross-check this invoice." }
            );
          if (res === null) {
            log(`extraction_${prefix}_error`, { jobId: ctx.jobId });
            unavailable();
            return;
          }
          const parsed = res.ok ? parseModelJson(res.text) : null;
          const checked = parsed && parsed.ok ? validateModelOutput(parsed.value) : null;
          if (res.ok && checked && checked.ok) {
            await recordUsage(res, `${prefix}_ok`);
            if (checked.data.document_type === "not_an_invoice") {
              recheckNotes.push({ code: "recheck_mismatch", severity: "warning", field: "document_type", message: `The ${name === "second" ? "second check" : "audit reading"} thought this file is not an invoice. Check the original.`, details: { first: firstReading.document_type, second: "not_an_invoice" } });
            } else {
              extraFull.push({ name, data: checked.data });
            }
          } else {
            await recordUsage(res, res.ok ? `${prefix}_invalid_output` : `${prefix}_${res.code}`);
            log(`extraction_${prefix}_unavailable`, { jobId: ctx.jobId, code: res.ok ? "invalid_model_output" : res.code });
            unavailable();
          }
        };
        await takeFull("second", secondRes);
        await takeFull("audit", auditRes);

        if (keyRes !== undefined) {
          const unavailable = () => recheckNotes.push({ code: "keyfigures_unavailable", severity: "info", message: "The key-figures reading (totals, amount in words, IRN) could not run, so one witness fewer was used for the grand total." });
          if (keyRes === null) {
            log("extraction_keyfigures_error", { jobId: ctx.jobId });
            unavailable();
          } else {
            const parsed = keyRes.ok ? parseModelJson(keyRes.text) : null;
            const checked = parsed && parsed.ok ? validateKeyFigures(parsed.value) : null;
            if (keyRes.ok && checked && checked.ok) {
              await recordUsage(keyRes, "keyfigures_ok");
              keyFigures = checked.data;
            } else {
              await recordUsage(keyRes, keyRes.ok ? "keyfigures_invalid_output" : `keyfigures_${keyRes.code}`);
              log("extraction_keyfigures_unavailable", { jobId: ctx.jobId, code: keyRes.ok ? "invalid_model_output" : keyRes.code });
              unavailable();
            }
          }
        }

        // Vote / compare the readings.
        const readings: ModelOutput[] = [firstReading, ...extraFull.map((x) => x.data)];
        layerCount = readings.length + (keyFigures ? 1 : 0) + parties.length;
        let rec: Reconciled | null = null;
        if (readings.length >= 3 || keyFigures || parties.length > 0) rec = reconcileMany(readings, checkCfg, keyFigures, parties);
        else if (readings.length === 2) rec = reconcile(readings[0], readings[1], checkCfg);
        if (rec) {
          model = rec.merged;
          agreed = rec.agreed;
          recheckNotes.push(...recheckFlags(rec));
        }

        // Extra blind parties readings while a GSTIN is still not verified (EXTRACTION_PARTIES_RETRIES). Each one is a new,
        // independent witness; the vote and the evidence are recomputed from scratch after every reading.
        let pr = resolveParties(readingsForParties(firstReading, extraFull), parties, model);
        let retries = wantParties ? cfg.partiesRetries ?? 1 : 0;
        while (retries > 0 && parties.length > 0 && needsAnotherPartiesReading(pr.verdicts)) {
          const left = cfg.deadlineMs - (now() - started);
          if (left < MIN_TIME_FOR_CALL_MS + VERIFY_SAVE_MARGIN_MS) break;
          retries -= 1;
          const before = parties.length;
          const res = await deps.gemini({ apiKey: cfg.apiKey, model: cfg.model, mime: ctx.mime, data: bytes, timeoutMs: Math.max(1_000, Math.min(cfg.timeoutMs, left - VERIFY_SAVE_MARGIN_MS)), maxOutputTokens: cfg.maxOutputTokens, fetchImpl: deps.fetchImpl, systemPrompt: PARTIES_SYSTEM_PROMPT, userPrompt: PARTIES_USER_PROMPT, responseSchema: buildPartiesSchema() }).catch(() => null);
          if (!(await takeParties(res, "parties_retry")) || parties.length === before) break;
          layerCount += 1;
          pr = resolveParties(readingsForParties(firstReading, extraFull), parties, model);
        }
        model = pr.merged;
        verdicts = pr.verdicts;
        recheckNotes.push(...pr.flags);
      }
    }
    if (!verdicts) {
      // Extra layers did not run (switched off or no time): the GSTINs are still judged by their format, check digit and state code.
      const pr = resolveParties([firstReading], [], model);
      verdicts = pr.verdicts;
    }

    // ---- Grand total: every reading, the printed amount in words and the invoice arithmetic are witnesses (total-check.ts). ----
    {
      const totals: ReadingTotal[] = [{ source: "first", total: firstReading.grand_total, words: firstReading.amount_in_words }];
      const names = ["second", "audit"] as const;
      for (const n of names) {
        const r = extraFull.find((x) => x.name === n);
        if (r) totals.push({ source: n, total: r.data.grand_total, words: r.data.amount_in_words });
      }
      if (keyFigures) totals.push({ source: "keyfigures", total: (keyFigures as KeyFigures).grand_total, words: (keyFigures as KeyFigures).amount_in_words });
      verdict = resolveGrandTotal(totals, model, checkCfg);
      recheckNotes.push(...verdict.flags);
      if (verdict.field && layerCount >= 2) {
        model = { ...model, grand_total: verdict.field };
        if (verdict.status === "confirmed" || verdict.status === "corrected") agreed = new Set([...(agreed ?? []), "grand_total"]);
      }
    }

    const normalized = normalizeExtraction(model, { model: cfg.model, now: new Date(now()), agreed });
    const extracted = normalized.extracted;
    let items = normalized.items;

    // Line-item maths reconciliation (line-fix.ts): quantity x unit price (less discount) x rate = taxable value. A misread digit
    // (INR 10,000 read as 1,000) is corrected here when the maths, the model's confidence and independent witnesses all agree;
    // everything else is left for the normal checks below and a human. The original value is kept in the field status and a flag.
    const lineFixFlags: ReviewFlag[] = [];
    if (checkCfg.lineFix !== false) {
      const fix = reconcileLineItems(items, extracted, { tolerancePaise: checkCfg.tolerancePaise, maxConfidence: checkCfg.lineFixMaxConfidence });
      items = fix.items;
      lineFixFlags.push(...fix.flags);
      if (fix.fixed > 0) log("extraction_line_autofix", { jobId: ctx.jobId, fixed: fix.fixed, skipped: fix.skipped });
    }

    // Foreign currency (import / cross-border) invoice: a printed exchange rate is kept and cross-checked; when none is printed the
    // reference rate of the invoice date is fetched (forex.ts) BEFORE the checks, so line and total maths can be verified in INR.
    // Line auto-correction above ran without it on purpose: a fetched market rate must never be used to "correct" a read value.
    const forexFlags: ReviewFlag[] = [];
    let forex: ForexResult | null = null;
    if (deps.fx && checkCfg.forex !== false) {
      const left = cfg.deadlineMs - (now() - started) - VERIFY_SAVE_MARGIN_MS;
      if (left >= 3_000) {
        try {
          forex = await resolveForex(extracted, items, deps.fx, { tolerancePaise: checkCfg.tolerancePaise });
          forexFlags.push(...forex.flags);
          if (forex.exchangeRate !== null && forex.fieldMeta) {
            extracted.exchange_rate = forex.exchangeRate;
            extracted.field_status.exchange_rate = forex.fieldMeta;
          }
        } catch {
          log("extraction_forex_error", { jobId: ctx.jobId });
        }
      }
    }
    const flags: ReviewFlag[] = [...extracted.review_flags, ...runChecks(extracted, items, checkCfg), ...recheckNotes, ...lineFixFlags, ...forexFlags];

    // GST validation engine verdict: saved with the invoice. A difference of up to INR 2.00 between the calculated and the
    // printed grand total is recorded as round_off_amount (source "computed"), so the original figures are never changed.
    const gstVerdict = validateInvoice({ extracted, items }, { tolerancePaise: checkCfg.tolerancePaise });
    extracted.validation_summary = { ...(gstVerdict.summary as unknown as Record<string, unknown>), ...(totalSummary(verdict, layerCount)), ...(forex && forex.summary ? { forex: forex.summary } : {}) };
    if (gstVerdict.patch.round_off_amount !== undefined) {
      extracted.round_off_amount = Math.round(gstVerdict.patch.round_off_amount * 100) / 100;
      extracted.field_status.round_off_amount = { state: "value", confidence: 1, source: "computed" };
    }

    // GST portal check of the supplier GSTIN against the invoice date (gst-portal.ts): active / cancelled, registered before the
    // invoice date, name match. Adds flags only. Skipped when it is not configured or when too little run time is left.
    if (deps.gstPortal) {
      const left = cfg.deadlineMs - (now() - started) - VERIFY_SAVE_MARGIN_MS;
      if (left >= 2_000) {
        try {
          const portal = await checkSupplierOnPortal(deps.gstPortal, extracted, { timeoutMs: Math.min(8_000, left) });
          flags.push(...portal.flags);
          if (portal.summary) extracted.validation_summary = { ...(extracted.validation_summary ?? {}), gst_portal: portal.summary };
        } catch {
          log("extraction_gst_portal_error", { jobId: ctx.jobId });
        }
      }
    }

    // Final verification gate: three layers (rules, consensus of every reading, independent evidence) over the whole content.
    {
      const audit = auditExtraction({
        extracted, items, merged: model, readings: readingsForParties(firstReading, extraFull), parties, verdicts,
        totalStatus: verdict && verdict.status !== "no_value" ? verdict.status : null, flags, now: new Date(now()),
      });
      flags.push(...audit.flags);
      extracted.validation_summary = {
        ...(extracted.validation_summary ?? {}),
        verification: {
          ...audit.report,
          gstin: verdicts ? { supplier_gstin: gstinSummary(verdicts.supplier_gstin), buyer_gstin: gstinSummary(verdicts.buyer_gstin) } : undefined,
        },
      };
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
