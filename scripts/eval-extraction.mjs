// Field-level evaluation of the extraction pipeline against tests/fixtures/*.truth.json.
//
//   Live (calls Gemini, costs a few cents):
//     GEMINI_API_KEY=... node --experimental-strip-types scripts/eval-extraction.mjs [--dir tests/fixtures] [--runs 1]
//   Offline (re-score saved outputs, no network):
//     node --experimental-strip-types scripts/eval-extraction.mjs --offline eval-output
//
// It prints counts per field. It does not print one headline "accuracy" number on purpose:
// with a handful of synthetic fixtures such a number would not mean anything.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getGeminiConfig } from "../lib/extraction/config.ts";
import { callGemini, estimateCostUsd } from "../lib/extraction/gemini.ts";
import { SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { preflight } from "../lib/extraction/preflight.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";
import { mergeTallies, scoreExtraction } from "../lib/extraction/score.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { runChecks } from "../lib/extraction/checks.ts";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dir = opt("--dir", "tests/fixtures");
const offlineDir = opt("--offline", null);
const runs = Math.max(1, Number(opt("--runs", "1")));
const outDir = "eval-output";

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
const truthFiles = readdirSync(dir).filter((f) => f.endsWith(".truth.json")).sort();
const header = {};
const items = {};
const perFile = [];
let cost = 0;
let apiCalls = 0;

const cfg = offlineDir ? null : getGeminiConfig();
if (!offlineDir && !cfg) {
  console.error("GEMINI_API_KEY is not set. Use --offline <dir> to score saved outputs.");
  process.exit(2);
}
if (!offlineDir) mkdirSync(outDir, { recursive: true });

for (const tf of truthFiles) {
  const truth = JSON.parse(readFileSync(join(dir, tf), "utf8"));
  const id = tf.replace(".truth.json", "");
  for (let run = 1; run <= runs; run++) {
    const label = runs > 1 ? `${id}#${run}` : id;
    let model = null;
    let note = "";
    if (offlineDir) {
      const p = join(offlineDir, `${label}.json`);
      if (!existsSync(p)) { perFile.push({ label, note: "no saved output" }); continue; }
      const v = validateModelOutput(JSON.parse(readFileSync(p, "utf8")));
      if (v.ok) model = v.data; else note = `invalid output: ${v.errors.slice(0, 3).join("; ")}`;
    } else {
      const bytes = new Uint8Array(readFileSync(join(dir, truth.file)));
      const mime = MIME[truth.file.split(".").pop().toLowerCase()];
      const pre = preflight(bytes, { expectedMime: mime, maxPdfPages: 10 });
      if (!pre.ok) { perFile.push({ label, note: `preflight: ${pre.code}` }); continue; }
      const res = await callGemini({ apiKey: cfg.apiKey, model: cfg.model, mime, data: bytes, timeoutMs: cfg.timeoutMs, maxOutputTokens: cfg.maxOutputTokens, highResolution: cfg.highResolution !== false });
      apiCalls += 1;
      if (res.usage) cost += estimateCostUsd(res.usage, cfg.inputPricePerMTok, cfg.outputPricePerMTok);
      if (!res.ok) { perFile.push({ label, note: `provider: ${res.code}` }); continue; }
      let parsed = null;
      try { parsed = JSON.parse(res.text); } catch { /* handled below */ }
      const v = validateModelOutput(parsed);
      writeFileSync(join(outDir, `${label}.json`), JSON.stringify(parsed, null, 2));
      if (v.ok) model = v.data; else note = `invalid output: ${v.errors.slice(0, 3).join("; ")}`;
    }
    if (!model) { perFile.push({ label, note }); continue; }
    const s = scoreExtraction(truth, model);
    mergeTallies(header, s.fields);
    mergeTallies(items, s.itemFields);
    const n = normalizeExtraction(model, { model: "eval" });
    const flags = [...n.extracted.review_flags, ...runChecks(n.extracted, n.items, { lowConfidence: 0.8, tolerancePaise: 100 })];
    perFile.push({ label, note: `items ${s.itemCount.extracted}/${s.itemCount.expected}${s.itemCount.match ? "" : " MISMATCH"}; flags: ${flags.map((f) => f.code).join(", ") || "none"}` });
  }
}

function table(title, tallies) {
  console.log(`\n${title}`);
  console.log("field".padEnd(18) + ["n", "correct", "wrong", "abstained", "invented", "ok-missing"].map((h) => h.padStart(11)).join(""));
  let n = 0;
  for (const [k, t] of Object.entries(tallies)) {
    const total = t.correct + t.wrong + t.abstained + t.invented + t.correct_missing;
    n += total;
    console.log(k.padEnd(18) + [total, t.correct, t.wrong, t.abstained, t.invented, t.correct_missing].map((v) => String(v).padStart(11)).join(""));
  }
  return n;
}
console.log(`Model: ${cfg ? cfg.model : "(offline)"}   fixtures: ${truthFiles.length}   runs each: ${runs}`);
for (const p of perFile) console.log(`- ${p.label}: ${p.note}`);
const nh = table("Header fields", header);
const ni = table("Line item fields", items);
console.log(`\nField checks scored: ${nh} header, ${ni} item. "wrong" = a value that differs from the truth. "invented" = a value for something absent on the document.`);
if (!offlineDir) console.log(`API calls: ${apiCalls}, approx cost: $${cost.toFixed(4)} (list prices from config)`);
