// Line-item maths reconciliation and auto-correction (lib/extraction/line-fix.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { ocrPlausible, reconcileLineItems } from "../lib/extraction/line-fix.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { f, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const run = (m, o = OPTS) => {
  const n = norm(m);
  return { ...reconcileLineItems(n.items, n.extracted, o), before: n.items };
};
// One honest line: 10 x 1,000 = 10,000 taxable, 1,800 GST, 11,800 total.
const good = (over = {}) => item({ quantity: f(10), unit_price: f(1000), taxable_value: f(10000), tax_amount: f(1800), line_total: f(11800), ...over });
const inv = (lines, over = {}) => model({ taxable_value: f(lines.reduce((s, l) => s + l.taxable_value.value, 0)), line_items: lines, ...over });

test("ocrPlausible: dropped digit, shifted point, one wrong digit, swapped digits; not random numbers", () => {
  assert.equal(ocrPlausible(1000, 10000), true);
  assert.equal(ocrPlausible(10000, 1000), true);
  assert.equal(ocrPlausible(11500, 1500), true);
  assert.equal(ocrPlausible(12.5, 125), true);
  assert.equal(ocrPlausible(1250, 1280), true);
  assert.equal(ocrPlausible(1520, 1250), true);
  assert.equal(ocrPlausible(1000, 7321), false);
  assert.equal(ocrPlausible(25, 26), false);
  assert.equal(ocrPlausible(1000, -1000), false);
});

test("taxable value read as 1,000 instead of 10,000: corrected, original kept, info note only", () => {
  // The model read 10,000 as 1,000 with low confidence; GST (1,800) and line total (11,800) still show the real value.
  const bad = good({ taxable_value: f(1000, 0.6) });
  const r = run(inv([bad, good()], { taxable_value: f(20000) }));
  assert.equal(r.fixed, 1);
  assert.equal(r.items[0].taxable_amount, 10000);
  assert.deepEqual(r.items[0].field_status.taxable_value.autoCorrected, { from: "1000", to: "10000" });
  assert.equal(r.items[0].field_status.taxable_value.source, "computed");
  assert.equal(r.before[0].taxable_amount, 1000, "input is not mutated");
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].code, "line_item_auto_corrected");
  assert.equal(r.flags[0].severity, "info");
  assert.equal(r.flags[0].details.original, 1000);
  assert.deepEqual(r.flags[0].details.witnesses, ["gst_amount", "line_total", "invoice_taxable_total"]);
});

test("unit price read as 100 instead of 1,000: taxable, GST and total all agree, so the price is fixed", () => {
  const r = run(inv([good({ unit_price: f(100, 0.7) })]));
  assert.equal(r.fixed, 1);
  assert.equal(r.items[0].unit_price, 1000);
  assert.equal(r.items[0].quantity, 10);
  assert.equal(r.flags[0].field, "unit_price");
});

test("quantity read as 1 instead of 10: fixed from the other two", () => {
  const r = run(inv([good({ quantity: f(1, 0.65) })]));
  assert.equal(r.fixed, 1);
  assert.equal(r.items[0].quantity, 10);
});

test("a correct line is never touched", () => {
  const r = run(inv([good(), good()]));
  assert.equal(r.fixed, 0);
  assert.equal(r.flags.length, 0);
  assert.equal(r.items[0].taxable_amount, 10000);
});

test("no independent evidence and no low confidence: not corrected, reason given", () => {
  const bad = good({ taxable_value: f(1000, 0.97), tax_amount: { status: "missing", value: null, confidence: 0.9 }, line_total: { status: "missing", value: null, confidence: 0.9 } });
  const r = run(model({ taxable_value: { status: "missing", value: null, confidence: 0.9 }, line_items: [bad] }));
  assert.equal(r.fixed, 0);
  assert.equal(r.items[0].taxable_amount, 1000);
  assert.equal(r.flags[0].code, "line_autofix_skipped");
  assert.equal(r.flags[0].details.reason, "weak_evidence");
});

test("the model was confident and only some witnesses agree: left for a human", () => {
  // Taxable 1,000 with confidence 0.99; only the GST amount supports 10,000 -> score 1 -> weak evidence, not fixed.
  const bad = good({ taxable_value: f(1000, 0.99), line_total: { status: "missing", value: null, confidence: 0.9 } });
  const r = run(model({ taxable_value: { status: "missing", value: null, confidence: 0.9 }, line_items: [bad] }));
  assert.equal(r.fixed, 0);
});

test("a confident misread is still corrected when all three witnesses agree", () => {
  const r = run(inv([good({ taxable_value: f(1000, 0.99) })], { taxable_value: f(10000) }));
  assert.equal(r.fixed, 1);
  assert.equal(r.items[0].taxable_amount, 10000);
});

test("maxConfidence option: a 0.97 value with two witnesses is left alone by default, corrected when the limit is raised", () => {
  const bad = good({ taxable_value: f(1000, 0.97) });
  const m = model({ taxable_value: { status: "missing", value: null, confidence: 0.9 }, line_items: [bad] });
  const strict = run(m);
  assert.equal(strict.fixed, 0);
  assert.equal(strict.flags[0].details.reason, "model_confident");
  assert.equal(run(m, { tolerancePaise: 100, maxConfidence: 0.98 }).fixed, 1);
});

test("a wrong value that is not a believable misread is not 'fixed'", () => {
  const r = run(inv([good({ taxable_value: f(7321, 0.5), tax_amount: f(1317.78), line_total: f(8638.78) })]));
  assert.equal(r.fixed, 0);
  assert.equal(r.flags[0].details.reason, "no_candidate");
});

test("discount as percent is used: 10 x 1,000 less 10% = 9,000", () => {
  const line = (t) => item({ quantity: f(10), unit_price: f(1000), discount: f(10), discount_type: f("PERCENT"), taxable_value: f(t, 0.6), tax_amount: f(1620), line_total: f(10620) });
  const r = run(model({ taxable_value: f(9000), line_items: [line(900)] }));
  assert.equal(r.fixed, 1);
  assert.equal(r.items[0].taxable_amount, 9000);
});

test("foreign currency: corrected only with a printed exchange rate", () => {
  // USD 100 x 10 = 1,000 USD x 83 = INR 83,000 taxable; read as 8,300 with low confidence. 18% GST = 14,940.
  const l = item({ quantity: f(10), unit_price: f(100), taxable_value: f(8300, 0.6), tax_amount: f(14940), line_total: f(97940) });
  const withRate = run(model({ currency: f("USD"), exchange_rate: f(83), taxable_value: f(83000), line_items: [l] }));
  assert.equal(withRate.fixed, 1);
  assert.equal(withRate.items[0].taxable_amount, 83000);
  const noRate = run(model({ currency: f("USD"), taxable_value: f(83000), line_items: [l] }));
  assert.equal(noRate.fixed, 0);
  assert.equal(noRate.items.length, 1);
});

test("two lines, each with its own misread: both fixed one after the other", () => {
  const r = run(inv([good({ taxable_value: f(1000, 0.6) }), good({ unit_price: f(100, 0.6) })], { taxable_value: f(20000) }));
  assert.equal(r.fixed, 2);
});

// ---- End to end through runExtraction ------------------------------------------------------------------------------------
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { minimalPdf, sha } from "./helpers.mjs";

async function pipeline(m, checkConfig) {
  const pdf = minimalPdf();
  const completes = [];
  const deps = {
    geminiConfig: { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 1, maxOutputTokens: 1000, verify: false, audit: false, totalCheck: false, partiesCheck: false },
    checkConfig, maxPdfPages: 10, now: () => Date.parse("2026-10-11T00:00:00Z"), sleep: async () => {}, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async () => ({ ok: true, text: JSON.stringify(m), usage: { inputTokens: 1, outputTokens: 1 } }),
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { completes.push(a); return "ok"; } },
  };
  const ctx = { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) };
  const r = await runExtraction(deps, ctx);
  return { r, saved: completes[0] };
}

// 10 x 1,000 = 10,000 + 900 CGST + 900 SGST = 11,800, but the line's taxable value was read as 1,000 (low confidence).
const misread = () => model({ taxable_value: f(10000), cgst: f(900), sgst: f(900), grand_total: f(11800), line_items: [good({ taxable_value: f(1000, 0.6) })] });

test("pipeline: misread line value is corrected, saved corrected, outcome completed with an info note", async () => {
  const { r, saved } = await pipeline(misread(), { lowConfidence: 0.8, tolerancePaise: 100 });
  assert.equal(r.outcome, "completed");
  assert.equal(saved.items[0].taxable_amount, 10000);
  assert.deepEqual(saved.items[0].field_status.taxable_value.autoCorrected, { from: "1000", to: "10000" });
  const codes = saved.extracted.review_flags.map((x) => x.code);
  assert.ok(codes.includes("line_item_auto_corrected"));
  assert.ok(!codes.includes("arithmetic_line_mismatch"));
  assert.ok(!codes.includes("low_confidence_item"));
});

test("pipeline: lineFix off keeps the old behaviour (warning, value untouched, human review)", async () => {
  const { r, saved } = await pipeline(misread(), { lowConfidence: 0.8, tolerancePaise: 100, lineFix: false });
  assert.equal(r.outcome, "needs_review");
  assert.equal(saved.items[0].taxable_amount, 1000);
  assert.ok(saved.extracted.review_flags.some((x) => x.code === "arithmetic_line_mismatch"));
});

test("review recompute keeps the audit note while the value is still the corrected one, and drops it after a reviewer changes it", async () => {
  const { computeReviewFlags } = await import("../lib/review/flags.ts");
  const n = norm(inv([good({ taxable_value: f(1000, 0.6) })], { taxable_value: f(10000) }));
  const fixed = reconcileLineItems(n.items, n.extracted, OPTS).items;
  const h = { vendor_name: "A", buyer_name: "B", vendor_gstin: null, buyer_gstin: null, invoice_number: "1", invoice_date: "2026-09-15", place_of_supply: null, currency: "INR", document_type: "tax_invoice", taxable_amount: 10000, discount_amount: null, cgst_amount: 900, sgst_amount: 900, igst_amount: null, cess_amount: null, total_amount: 11800 };
  const opts = { lowConfidence: 0.8, tolerancePaise: 100 };
  assert.ok(computeReviewFlags(h, n.extracted.field_status, fixed, opts).some((x) => x.code === "line_item_auto_corrected"));
  const edited = fixed.map((x) => ({ ...x, taxable_amount: 9999, field_status: { ...x.field_status, taxable_value: { state: "value", confidence: 1, source: "human" } } }));
  assert.ok(!computeReviewFlags(h, n.extracted.field_status, edited, opts).some((x) => x.code === "line_item_auto_corrected"));
});
