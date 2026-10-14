// End-to-end accuracy evaluation of the WHOLE extraction pipeline (lib/extraction/pipeline.ts): baseline configuration versus the
// updated one, on the same dataset. Two modes:
//
//   Simulated (default, offline, free, deterministic):
//     node --experimental-strip-types scripts/eval-pipeline.mjs
//     A scripted provider returns hand-written readings with injected errors (tests/helpers/eval-dataset.mjs). This measures what the
//     pipeline's CODE does with a given set of readings (voting, checks, source verification, false corrections, review flags).
//     It does NOT measure how often the real model misreads an invoice, and it cannot show the effect of the dynamic prompt.
//
//   Live (calls Gemini, costs money; the only mode that can measure real accuracy, latency and cost):
//     GEMINI_API_KEY=... node --experimental-strip-types scripts/eval-pipeline.mjs --mode live [--runs 3] [--dir tests/fixtures]
//     Runs every tests/fixtures/*.truth.json file through the real provider under each configuration.
//
// Add --json <file> to also save the numbers. Nothing here writes to a database; the store is an in-memory stub.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { callGemini, estimateCostUsd } from "../lib/extraction/gemini.ts";
import { getGeminiConfig } from "../lib/extraction/config.ts";
import { parseModelJson } from "../lib/extraction/parse-json.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const mode = opt("--mode", "simulated");
const runs = Math.max(1, Number(opt("--runs", "1")));
const dir = opt("--dir", "tests/fixtures");
const jsonOut = opt("--json", null);

const CHECK_CFG = { lowConfidence: 0.8, tolerancePaise: 100, lineFix: true, lineFixMaxConfidence: 0.95, dedupeRows: true, forex: true };
const CONFIGS = [
  { name: "first-reading-only", note: "every extra layer off", flags: { verify: false, audit: false, totalCheck: false, partiesCheck: false, dynamicPrompt: false, sourceVerify: false } },
  { name: "baseline", note: "all layers before Part 1 and Part 3: second / audit / key-figures / parties readings, vote, line fix; dynamic prompt and source verification OFF", flags: { dynamicPrompt: false, sourceVerify: false } },
  { name: "updated", note: "current defaults: dynamic prompt ON, source verification ON", flags: {} },
];

// ---- scoring ---------------------------------------------------------------------------------------------------------------------
const HEADER = { vendor_name: "supplier_name", vendor_gstin: "supplier_gstin", buyer_name: "buyer_name", buyer_gstin: "buyer_gstin", invoice_number: "invoice_number", invoice_date: "invoice_date", place_of_supply: "place_of_supply", taxable_amount: "taxable_value", discount_amount: "discount_total", cgst_amount: "cgst", sgst_amount: "sgst", igst_amount: "igst", cess_amount: "cess", total_amount: "grand_total" };
const CRITICAL_HEADER = new Set(["taxable_value", "cgst", "sgst", "igst", "cess", "grand_total"]);
const ITEM = { description: "description", hsn_code: "hsn_sac", quantity: "quantity", unit: "unit", unit_price: "unit_price", taxable_amount: "taxable_value", gst_rate: "gst_rate" };
const ITEM_KEYS_FOR_ACCURACY = ["quantity", "unit_price", "taxable_value", "gst_rate"];
const same = (truth, got) => {
  if (truth === null || truth === undefined) return got === null || got === undefined;
  if (got === null || got === undefined) return false;
  if (typeof truth === "number") return typeof got === "number" && Math.abs(got - truth) < 0.005;
  return String(got).toLowerCase().replace(/\s+/g, " ").trim() === String(truth).toLowerCase().replace(/\s+/g, " ").trim();
};
// plain truth: { supplier_name: value|null, ..., line_items: [{description, ...}] }
export function plainTruth(model) {
  const v = (x) => (x && x.status === "present" && x.value !== null && x.value !== undefined ? x.value : null);
  const out = {};
  for (const k of Object.values(HEADER)) out[k] = v(model[k]);
  out.line_items = model.line_items.map((it) => Object.fromEntries(Object.values(ITEM).map((k) => [k, v(it[k])])));
  return out;
}
const firstReadingPlain = (m) => plainTruth(m);

function score(truth, extracted, items, first) {
  const s = { fields: 0, fieldsOk: 0, crit: 0, critOk: 0, lineFields: 0, lineOk: 0, itemCountOk: truth.line_items.length === items.length, changedToCorrect: 0, falseCorrections: 0, harmfulCorrections: 0, criticalWrong: 0, wrongFields: [] };
  const consider = (key, t, got, crit, firstVal, isLine) => {
    const ok = same(t, got);
    s.fields += 1; if (ok) s.fieldsOk += 1; else s.wrongFields.push(key);
    if (crit) { s.crit += 1; if (ok) s.critOk += 1; else s.criticalWrong += 1; }
    if (isLine) { s.lineFields += 1; if (ok) s.lineOk += 1; }
    if (first !== undefined && !same(firstVal, got)) { // the saved value is not what the first reading said: a correction by the layers
      if (ok) s.changedToCorrect += 1; else { s.falseCorrections += 1; if (same(t, firstVal)) s.harmfulCorrections += 1; }
    }
  };
  for (const [col, key] of Object.entries(HEADER)) if (truth[key] !== undefined) consider(key, truth[key], extracted[col], CRITICAL_HEADER.has(key), first ? first[key] : undefined, false);
  truth.line_items.forEach((ti, i) => {
    for (const [col, key] of Object.entries(ITEM)) {
      if (ti[key] === undefined) continue; // not stated in the truth file: not scored
      const got = items[i] ? items[i][col] : null;
      const isAcc = ITEM_KEYS_FOR_ACCURACY.includes(key);
      consider(`item${i + 1}.${key}`, ti[key], got, key === "taxable_value", first ? (first.line_items[i] ? first.line_items[i][key] : null) : undefined, isAcc);
    }
  });
  return s;
}

// ---- running one invoice through the real pipeline with an in-memory store ----------------------------------------------------------
async function runOne({ bytes, mime, gemini, flags, cfgBase, pages }) {
  const calls = { n: 0, first: null, usage: [] };
  let t = Date.now();
  const deps = {
    geminiConfig: { ...cfgBase, ...flags }, checkConfig: CHECK_CFG, maxPdfPages: 10, fx: null, gstPortal: null,
    now: mode === "simulated" ? () => t : Date.now, sleep: async (ms) => { t += ms; }, random: () => 0, log: () => {},
    files: { download: async () => bytes },
    gemini: async (input) => {
      calls.n += 1;
      const res = await gemini(input);
      if (res.usage) calls.usage.push(res.usage);
      if (!calls.first && res.ok) { const p = parseModelJson(res.text); const v = p.ok ? validateModelOutput(p.value) : null; if (v && v.ok) calls.first = v.data; }
      if (mode === "simulated") t += 1000;
      return res;
    },
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { calls.saved = a; return "ok"; } },
  };
  const ctx = { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime, sha256: createHash("sha256").update(bytes).digest("hex") };
  const started = process.hrtime.bigint();
  const r = await runExtraction(deps, ctx);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { r, calls, ms, saved: calls.saved ?? null };
}

function emptyAgg() { return { invoices: 0, failed: 0, fields: 0, fieldsOk: 0, crit: 0, critOk: 0, lineFields: 0, lineOk: 0, itemCountOk: 0, changedToCorrect: 0, falseCorrections: 0, harmfulCorrections: 0, needsReview: 0, silentWrong: 0, sourceUnresolved: 0, sourceCorrected: 0, apiCalls: 0, wallMs: 0, costUsd: 0, perInvoice: [] }; }
function add(agg, id, out, s, cfg) {
  agg.invoices += 1;
  if (!s) { agg.failed += 1; agg.perInvoice.push({ id, outcome: out.r.outcome, error: out.r.errorCode }); return; }
  for (const k of ["fields", "fieldsOk", "crit", "critOk", "lineFields", "lineOk", "changedToCorrect", "falseCorrections", "harmfulCorrections"]) agg[k] += s[k];
  if (s.itemCountOk) agg.itemCountOk += 1;
  const flags = out.saved.extracted.review_flags;
  const needs = out.r.outcome === "needs_review";
  if (needs) agg.needsReview += 1;
  if (!needs && s.criticalWrong > 0) agg.silentWrong += 1;
  agg.sourceUnresolved += flags.filter((f) => f.code === "source_verify_unresolved").length;
  agg.sourceCorrected += flags.filter((f) => f.code === "source_verify_corrected").length;
  agg.apiCalls += out.calls.n;
  agg.wallMs += out.ms;
  agg.costUsd += out.calls.usage.reduce((a, u) => a + estimateCostUsd(u, cfg.inputPricePerMTok, cfg.outputPricePerMTok), 0);
  agg.perInvoice.push({ id, outcome: out.r.outcome, wrong: s.wrongFields, calls: out.calls.n });
}
const pct = (a, b) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);

async function main() {
  const results = {};
  if (mode === "simulated") {
    const { SCENARIOS } = await import("../tests/helpers/eval-dataset.mjs");
    const { setup } = await import("../tests/helpers/pipeline-harness.mjs");
    for (const c of CONFIGS) {
      const agg = emptyAgg();
      for (const sc of SCENARIOS) {
        // The harness answers each reading role from the scenario; the evaluation's own wrapper only counts and scores.
        const h = setup({ reading: sc.reading, answers: { verify: sc.layers?.verify, audit: sc.layers?.audit, source: sc.source }, config: c.flags, file: sc.file, pages: sc.pages ?? 1 });
        const out = await runOne({ bytes: h.bytes, mime: h.ctx.mime, gemini: h.deps.gemini, flags: c.flags, cfgBase: h.deps.geminiConfig, pages: sc.pages });
        const truth = plainTruth(sc.truth);
        add(agg, sc.id, out, out.saved && out.saved.extracted ? score(truth, out.saved.extracted, out.saved.items, firstReadingPlain(sc.reading)) : null, h.deps.geminiConfig);
      }
      results[c.name] = agg;
    }
  } else {
    const cfg = getGeminiConfig();
    if (!cfg) { console.error("GEMINI_API_KEY is not set (live mode needs it)."); process.exit(2); }
    const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
    const truthFiles = readdirSync(dir).filter((x) => x.endsWith(".truth.json")).sort();
    for (const c of CONFIGS) {
      const agg = emptyAgg();
      for (const tf of truthFiles) {
        const truthRaw = JSON.parse(readFileSync(join(dir, tf), "utf8"));
        const bytes = new Uint8Array(readFileSync(join(dir, truthRaw.file)));
        const mime = MIME[truthRaw.file.split(".").pop().toLowerCase()];
        const truth = { ...Object.fromEntries(Object.values(HEADER).map((k) => [k, k in truthRaw ? truthRaw[k] : undefined])), line_items: (truthRaw.line_items ?? []).map((it) => ({ ...Object.fromEntries(Object.values(ITEM).map((k) => [k, it[k]])) })) };
        for (let i = 0; i < runs; i++) {
          const out = await runOne({ bytes, mime, gemini: (input) => callGemini(input), flags: c.flags, cfgBase: cfg });
          // Only keys the truth file states are scored (same rule as scripts/eval-extraction.mjs).
          const scored = out.saved && out.saved.extracted ? score(truth, out.saved.extracted, out.saved.items, out.calls.first ? firstReadingPlain(out.calls.first) : undefined) : null;
          add(agg, `${tf.replace(".truth.json", "")}#${i + 1}`, out, scored, cfg);
        }
      }
      results[c.name] = agg;
    }
  }
  report(results);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ mode, runs, configs: CONFIGS, results }, null, 2));
}
function report(results) {
  console.log(`\nMode: ${mode}${mode === "live" ? `, runs per fixture: ${runs}` : " (scripted provider, hand-written readings; NOT real model accuracy)"}`);
  const names = Object.keys(results);
  const rows = [
    ["invoices", (a) => a.invoices],
    ["failed runs", (a) => a.failed],
    ["field exact-match", (a) => `${a.fieldsOk}/${a.fields} (${pct(a.fieldsOk, a.fields)})`],
    ["critical financial fields", (a) => `${a.critOk}/${a.crit} (${pct(a.critOk, a.crit)})`],
    ["line-item values (qty, price, taxable, rate)", (a) => `${a.lineOk}/${a.lineFields} (${pct(a.lineOk, a.lineFields)})`],
    ["line-item count correct", (a) => `${a.itemCountOk}/${a.invoices - a.failed}`],
    ["fields changed to the truth by the layers", (a) => a.changedToCorrect],
    ["FALSE corrections (changed, now wrong)", (a) => a.falseCorrections],
    ["  of which a correct value was made wrong", (a) => a.harmfulCorrections],
    ["invoices sent to review (needs_review)", (a) => `${a.needsReview}/${a.invoices - a.failed}`],
    ["SILENT errors (critical field wrong, not flagged)", (a) => a.silentWrong],
    ["unresolved source-check flags", (a) => a.sourceUnresolved],
    ["source-check corrections applied", (a) => a.sourceCorrected],
    ["provider calls / invoice", (a) => (a.invoices - a.failed ? (a.apiCalls / (a.invoices - a.failed)).toFixed(2) : "n/a")],
    [mode === "live" ? "wall latency / invoice (real, ms)" : "code time / invoice (ms; no network, NOT real latency)", (a) => (a.invoices - a.failed ? (a.wallMs / (a.invoices - a.failed)).toFixed(mode === "live" ? 0 : 1) : "n/a")],
    [mode === "live" ? "cost / invoice (USD, from real token usage)" : "cost / invoice", (a) => (mode === "live" && a.invoices - a.failed ? `$${(a.costUsd / (a.invoices - a.failed)).toFixed(5)}` : "not measured (scripted tokens)")],
  ];
  console.log("".padEnd(52) + names.map((n) => n.padStart(26)).join(""));
  for (const [label, fn] of rows) console.log(label.padEnd(52) + names.map((n) => String(fn(results[n])).padStart(26)).join(""));
  for (const c of CONFIGS) console.log(`\n${c.name}: ${c.note}`);
  const b = results.baseline, u = results.updated;
  if (b && u) {
    console.log("\nPer-invoice differences (baseline -> updated):");
    for (const p of u.perInvoice) {
      const q = b.perInvoice.find((x) => x.id === p.id);
      if (!q) continue;
      const same_ = JSON.stringify([q.wrong, q.outcome]) === JSON.stringify([p.wrong, p.outcome]);
      if (!same_) console.log(`- ${p.id}: wrong [${(q.wrong ?? []).join(", ")}] ${q.outcome}  ->  wrong [${(p.wrong ?? []).join(", ")}] ${p.outcome}  (calls ${q.calls} -> ${p.calls})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
