// Scripted-provider harness for end-to-end runs of lib/extraction/pipeline.ts. No network, no real model.
// Every provider call is answered from a script, so a run is deterministic. It tells the reading roles apart the way the
// pipeline builds them (response schema, prompt text), so one scenario can give each role its own answer.
import { runExtraction } from "../../lib/extraction/pipeline.ts";
import { AUDIT_SYSTEM_PROMPT, KEYFIGURES_SYSTEM_PROMPT, PARTIES_SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from "../../lib/extraction/prompt.ts";
import { SOURCE_SYSTEM_PROMPT } from "../../lib/extraction/source-verify.ts";
import { minimalPdf, png, sha } from "../helpers.mjs";

export const BASE_CFG = { apiKey: "SECRET-KEY-123", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true, audit: true, totalCheck: true, partiesCheck: true, dynamicPrompt: true, sourceVerify: true, partiesRetries: 1 };
export const CHECK_CFG = { lowConfidence: 0.8, tolerancePaise: 100, lineFix: true, lineFixMaxConfidence: 0.95, dedupeRows: true, forex: true };

export function roleOf(input) {
  if (input.systemPrompt === SOURCE_SYSTEM_PROMPT) return "source";
  const sp = input.systemPrompt ?? "";
  if (input.responseSchema) {
    const props = JSON.stringify(input.responseSchema);
    return props.includes("printed_gstins") ? "parties" : props.includes("grand_total") ? "keyfigures" : "other";
  }
  // verify / audit prompts are the fixed prompt + their own extra block (the dynamic section is added after it)
  if (sp.includes(AUDIT_SYSTEM_PROMPT.slice(AUDIT_SYSTEM_PROMPT.length - 200, AUDIT_SYSTEM_PROMPT.length - 20))) return "audit";
  if (sp.includes(VERIFY_SYSTEM_PROMPT.slice(VERIFY_SYSTEM_PROMPT.length - 200, VERIFY_SYSTEM_PROMPT.length - 20))) return "verify";
  return "first";
}

const ok = (obj) => ({ ok: true, text: typeof obj === "string" ? obj : JSON.stringify(obj), usage: { inputTokens: 1200, outputTokens: 400 } });
export { ok };

// keyfigures / parties answers derived from a full reading (what a faithful blind reader would return)
export function keyFiguresFrom(m) {
  const k = {};
  for (const key of ["taxable_value", "discount_total", "cgst", "sgst", "igst", "cess", "grand_total"]) if (m[key]) k[key] = m[key];
  return k;
}
export function partiesFrom(m) {
  const p = {};
  for (const key of ["supplier_name", "supplier_gstin", "buyer_name", "buyer_gstin", "place_of_supply"]) if (m[key]) p[key] = m[key];
  const printed = [];
  if (m.supplier_gstin?.value) printed.push({ value: m.supplier_gstin.value, role: "supplier", label: "GSTIN" });
  if (m.buyer_gstin?.value) printed.push({ value: m.buyer_gstin.value, role: "buyer", label: "Buyer GSTIN" });
  p.printed_gstins = printed;
  return p;
}

// answers: { first, verify, audit, keyfigures, parties, source } each = value | (input, state) => value | Error | undefined (= default)
// A role's value may also be an array: consumed one per call (the last one repeats). `reading` is the default for first/verify/audit.
export function setup({ reading, answers = {}, config = {}, check = CHECK_CFG, file = "pdf", pages = 1, step = 1000, fx = null } = {}) {
  const bytes = file === "png" ? png(1200, 1600) : minimalPdf(pages);
  const mime = file === "png" ? "image/png" : "application/pdf";
  const state = { calls: [], usage: [], completes: [], logs: [] };
  const counters = {};
  let t = Date.parse("2026-10-14T00:00:00Z");
  const pick = (role, input) => {
    const spec = answers[role];
    counters[role] = (counters[role] ?? 0) + 1;
    let v = spec;
    if (Array.isArray(spec)) v = spec[Math.min(counters[role] - 1, spec.length - 1)];
    if (typeof v === "function") v = v(input, state);
    if (v === undefined) {
      if (role === "keyfigures") v = keyFiguresFrom(reading);
      else if (role === "parties") v = partiesFrom(reading);
      else if (role === "source") v = { ok: true, text: JSON.stringify({ results: [] }), usage: { inputTokens: 100, outputTokens: 20 } };
      else v = reading;
    }
    return v;
  };
  const deps = {
    geminiConfig: { ...BASE_CFG, ...config }, checkConfig: check, maxPdfPages: 10, fx, now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0,
    log: (event, data) => state.logs.push({ event, data }),
    files: { download: async () => bytes },
    gemini: async (input) => {
      const role = roleOf(input);
      state.calls.push({ role, input });
      t += step;
      const v = pick(role, input);
      if (v instanceof Error) throw v;
      if (v && typeof v === "object" && "ok" in v) return v;
      return ok(v);
    },
    store: {
      recordUsage: async (u) => { state.usage.push(u); },
      findDuplicateCandidates: async () => [],
      complete: async (a) => { state.completes.push(a); return "ok"; },
    },
  };
  const ctx = { jobId: "job-1", invoiceId: "inv-1", firmId: "firm-1", userId: "user-1", storagePath: "p", mime, sha256: sha(bytes) };
  return { deps, ctx, state, bytes, now: () => t };
}

export async function run(opts) {
  const s = setup(opts);
  const started = process.hrtime.bigint();
  const result = await runExtraction(s.deps, s.ctx);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const saved = s.state.completes[0] ?? null;
  return { ...s, result, saved, extracted: saved?.extracted ?? null, items: saved?.items ?? [], wallMs: ms, callsBy: (role) => s.state.calls.filter((c) => c.role === role) };
}

// Shape the saved record the way the database / export code sees an invoice row.
export function toExportRow(extracted, over = {}) {
  const tax = ["cgst_amount", "sgst_amount", "igst_amount", "cess_amount"].reduce((a, k) => a + (extracted[k] ?? 0), 0);
  return {
    id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-14T04:30:00+00:00", verified_at: "2026-10-14T05:00:00+00:00",
    vendor_name: extracted.vendor_name, vendor_gstin: extracted.vendor_gstin, buyer_name: extracted.buyer_name, buyer_gstin: extracted.buyer_gstin,
    invoice_number: extracted.invoice_number, invoice_date: extracted.invoice_date, place_of_supply: extracted.place_of_supply, currency: extracted.currency,
    document_type: extracted.document_type, taxable_amount: extracted.taxable_amount, discount_amount: extracted.discount_amount, cgst_amount: extracted.cgst_amount,
    sgst_amount: extracted.sgst_amount, igst_amount: extracted.igst_amount, cess_amount: extracted.cess_amount, tax_total: Math.round(tax * 100) / 100,
    total_amount: extracted.total_amount, confidence: extracted.confidence, review_flags: extracted.review_flags, ...over,
  };
}
