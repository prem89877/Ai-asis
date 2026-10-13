import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { runChecks, outcomeFor } from "../lib/extraction/checks.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";
import { suggestGstinFixes } from "../lib/extraction/gstin.ts";
import { lineSteps, isForeign, checkLineItems } from "../lib/extraction/arithmetic.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { model, item, f, missing, minimalPdf, sha } from "./helpers.mjs";

const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };

// USD export invoice. Unit prices in USD, taxable values converted to INR at 83.50.
//   line 1: 5 x 1200 - 100 discount = 5900 USD -> 492,650.00 INR      line 2: 2 x 300 = 600 USD -> 50,100.00 INR
//   taxable 542,750.00 + IGST 18% 97,695.00 + Cess 1% 5,427.50 = 645,872.50
const line1 = (o = {}) => item({ description: f("Machine"), quantity: f(5), unit_price: f(1200), discount: f(100), taxable_value: f(492650), gst_rate: f(18), tax_amount: f(88677), line_total: f(581327), ...o });
const line2 = (o = {}) => item({ description: f("Spares"), quantity: f(2), unit_price: f(300), discount: missing(), taxable_value: f(50100), gst_rate: f(18), tax_amount: f(9018), line_total: f(59118), ...o });
const usd = (over = {}) => {
  const m = model({
    currency: f("USD"), exchange_rate: f(83.5), buyer_gstin: missing(),
    taxable_value: f(542750), cgst: missing(), sgst: missing(), igst: f(97695), cess: f(5427.5), grand_total: f(645872.5),
    line_items: [line1(), line2()], ...over,
  });
  return m;
};
function run(m, opts = OPTS) {
  const r = normalizeExtraction(m, { model: "m", now: new Date("2026-10-11") });
  return { ...r, flags: runChecks(r.extracted, r.items, opts) };
}
const arith = (flags) => flags.filter((x) => x.code.startsWith("arithmetic_"));

test("helpers: calculation order gross -> net -> INR taxable", () => {
  const s = lineSteps(5, 1200, 100, 83.5);
  assert.deepEqual(s, { gross: 6000, net: 5900, taxable: 492650 });
  assert.equal(isForeign("USD", null), true);
  assert.equal(isForeign("INR", null), false);
  assert.equal(isForeign("INR", 83.5), true);
  assert.equal(isForeign(null, null), false);
});

test("USD invoice with a printed exchange rate, item discount and cess: no arithmetic flags", () => {
  const r = run(usd());
  assert.equal(r.extracted.exchange_rate, 83.5);
  assert.deepEqual(arith(r.flags), []);
  assert.ok(!r.flags.some((x) => x.code === "forex_rate_unverified"));
  assert.equal(outcomeFor(r.flags.filter((x) => x.code !== "missing_field")), "completed");
});

test("USD invoice with no printed rate: the rate the item lines agree on is used", () => {
  const m = usd();
  delete m.exchange_rate;
  const r = run(m);
  assert.deepEqual(arith(r.flags), []);
  assert.ok(!r.flags.some((x) => x.code === "forex_rate_unverified"));
});

test("a wrong converted line is flagged with the rate that was used", () => {
  const r = run(usd({ line_items: [line1({ taxable_value: f(492000) }), line2()] }));
  const fl = r.flags.find((x) => x.code === "arithmetic_line_mismatch");
  assert.ok(fl);
  assert.equal(fl.itemPosition, 1);
  assert.equal(fl.details.exchangeRate, 83.5);
  assert.equal(fl.details.rateSource, "printed");
  assert.equal(fl.details.expected, 492650);
  assert.match(fl.message, /exchange rate 83.5/);
});

test("without a printed rate, a line that disagrees with the other lines is flagged", () => {
  const m = usd({ line_items: [line1(), line2({ taxable_value: f(45000) })] });
  delete m.exchange_rate;
  const fl = run(m).flags.find((x) => x.code === "arithmetic_line_mismatch");
  assert.ok(fl);
  assert.equal(fl.details.rateSource, "from other lines");
});

test("foreign currency, one line, no rate: cannot be checked, so only an info note (never a warning)", () => {
  const m = usd({ line_items: [line1()], taxable_value: f(492650), igst: f(88677), cess: f(4926.5), grand_total: f(586253.5) });
  delete m.exchange_rate;
  const r = run(m);
  assert.equal(r.flags.some((x) => x.code === "arithmetic_line_mismatch"), false);
  assert.equal(r.flags.find((x) => x.code === "forex_rate_unverified").severity, "info");
  assert.deepEqual(arith(r.flags), []);
});

test("everything in USD (no conversion) still passes the plain check", () => {
  const m = model({ currency: f("USD"), grand_total: f(1180) }); // 2 x 500 = 1000 taxable, 90 + 90 tax
  assert.deepEqual(arith(run(m).flags), []);
});

test("discount printed in INR (already converted) is accepted", () => {
  const r = run(usd({ line_items: [line1({ discount: f(8350) }), line2()] }));
  assert.deepEqual(arith(r.flags), []);
});

test("INR invoices keep the old behaviour", () => {
  const bad = model({ line_items: [item({ quantity: f(3) })] });
  assert.ok(run(bad).flags.some((x) => x.code === "arithmetic_line_mismatch"));
  assert.ok(!run(model()).flags.some((x) => x.code === "arithmetic_line_mismatch"));
});

test("totals: taxable + IGST + Cess = grand total, round-off up to INR 2.00 is accepted", () => {
  assert.deepEqual(arith(run(usd({ grand_total: f(645873) })).flags), []); // 0.50 off
  assert.deepEqual(arith(run(usd({ grand_total: f(645873.5) })).flags), []); // exactly 1.00 off
  assert.deepEqual(arith(run(usd({ grand_total: f(645874) })).flags), []); // 1.50 off: absorbed as round-off
  const bad = run(usd({ grand_total: f(645875) })).flags.find((x) => x.code === "arithmetic_total_mismatch"); // 2.50 off
  assert.ok(bad);
  assert.equal(bad.details.expected, 645872.5);
});

test("totals: forgetting the cess is caught", () => {
  const r = run(usd({ grand_total: f(640445) })); // 542,750 + 97,695
  assert.ok(r.flags.some((x) => x.code === "arithmetic_total_mismatch"));
});

test("totals: grand total printed in USD while taxes are in INR is accepted when the rate is printed", () => {
  assert.deepEqual(arith(run(usd({ grand_total: f(7734.88) })).flags), []);
  assert.ok(run(usd({ grand_total: f(7800) })).flags.some((x) => x.code === "arithmetic_total_mismatch"));
});

test("totals: when the header taxable value was not read, the item sum is used", () => {
  const ok = run(usd({ taxable_value: missing() }));
  assert.ok(!ok.flags.some((x) => x.code === "arithmetic_total_mismatch"));
  const bad = run(usd({ taxable_value: missing(), grand_total: f(600000) })).flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(bad);
  assert.equal(bad.details.taxableFromItems, true);
});

test("exchange_rate is optional in the model output and validated when present", () => {
  assert.equal(validateModelOutput(model()).ok, true);
  assert.equal(validateModelOutput(usd()).ok, true);
  assert.equal(validateModelOutput(usd({ exchange_rate: { status: "missing", value: 83.5, confidence: 1 } })).ok, false);
  assert.equal(validateModelOutput({ ...model(), surprise: 1 }).ok, false);
});

test("a non-positive exchange rate is not used and is flagged", () => {
  const r = run(usd({ exchange_rate: f(0) }));
  assert.equal(r.extracted.exchange_rate, null);
  assert.ok(r.flags.concat(r.extracted.review_flags).some((x) => x.code === "invalid_exchange_rate"));
});

// ---- GSTIN repair suggestions ----------------------------------------------------------------------------------------
test("GSTIN suggestions: look-alike character, wrong check digit, nothing to suggest", () => {
  assert.deepEqual(suggestGstinFixes("27AAPFU0939F12V"), ["27AAPFU0939F1ZV"]); // 2 instead of Z
  assert.ok(suggestGstinFixes("27AAPFUO939F1ZV").includes("27AAPFU0939F1ZV")); // O instead of 0
  assert.ok(suggestGstinFixes("27AAPFU0939F1ZW").includes("27AAPFU0939F1ZV")); // only the check digit
  assert.deepEqual(suggestGstinFixes("27AAPFU0939F1ZV"), []); // already valid
  assert.deepEqual(suggestGstinFixes("12345"), []);
  assert.deepEqual(suggestGstinFixes("ZZZZZZZZZZZZZZZ"), []);
  assert.ok(suggestGstinFixes("27aapfu0939f1zw").length >= 1); // case and spaces do not matter
});

test("GSTIN flag text carries the suggestion; the suggestion is never applied to the value", () => {
  const r = run(model({ supplier_gstin: f("27AAPFU0939F12V") }));
  assert.equal(r.extracted.vendor_gstin, "27AAPFU0939F12V");
  const fl = r.extracted.review_flags.find((x) => x.code === "invalid_gstin");
  assert.match(fl.message, /Possible correct GSTIN: 27AAPFU0939F1ZV/);
  assert.deepEqual(fl.details.suggestions, ["27AAPFU0939F1ZV"]);
});

test("GSTIN auto-correction needs two agreeing readings with confidence above 95%; otherwise it is only a warning", () => {
  const m = (c) => model({ supplier_gstin: f("27AAPFU0939F1ZW", c) });
  const agreed = new Set(["supplier_gstin"]);
  const hi = normalizeExtraction(m(0.97), { model: "m", agreed });
  assert.equal(hi.extracted.vendor_gstin, "27AAPFU0939F1ZV");
  const note = hi.extracted.review_flags.find((x) => x.field === "supplier_gstin");
  assert.equal(note.code, "gstin_auto_corrected");
  assert.equal(note.severity, "info");
  assert.equal(note.message, "GSTIN Auto-Corrected (Checksum Fixed)");
  for (const [c, ag] of [[0.95, agreed], [0.9, agreed], [0.99, undefined]]) {
    const r = normalizeExtraction(m(c), { model: "m", agreed: ag });
    const fl = r.extracted.review_flags.find((x) => x.field === "supplier_gstin");
    assert.equal(fl.code, "invalid_gstin", `${c} ${ag ? "agreed" : "single"}`);
    assert.equal(fl.severity, "warning");
    assert.equal(r.extracted.vendor_gstin, "27AAPFU0939F1ZW"); // untouched
  }
  const off = normalizeExtraction(m(0.97), { model: "m", agreed, gstinAutoCorrect: false });
  assert.equal(off.extracted.vendor_gstin, "27AAPFU0939F1ZW");
});

// ---- Review screen with a foreign-currency invoice (no stored exchange rate) --------------------------------------------
test("review recompute: USD invoice is not flagged for line math or totals", () => {
  const h = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null]));
  const header = { ...h, vendor_name: "Acme", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", invoice_number: "EXP-1", invoice_date: "2026-09-15", place_of_supply: "Foreign country (96)", currency: "USD", document_type: "tax_invoice", taxable_amount: 542750, igst_amount: 97695, cess_amount: 5427.5, total_amount: 645872.5 };
  const mk = (q, p, d, t, tax) => ({ description: "x", hsn_code: "8471", quantity: q, unit: "Nos", unit_price: p, discount_amount: d, taxable_amount: t, gst_rate: 18, gst_amount: tax, line_total: null, field_status: {} });
  const fsv = Object.fromEntries(["supplier_name", "supplier_gstin", "buyer_name", "invoice_number", "invoice_date", "taxable_value", "grand_total", "igst"].map((k) => [k, { state: "value", confidence: 1 }]));
  const flags = computeReviewFlags(header, fsv, [mk(5, 1200, 100, 492650, 88677), mk(2, 300, null, 50100, 9018)], OPTS, new Date("2026-10-11"));
  assert.deepEqual(flags.filter((x) => x.code.startsWith("arithmetic_")), []);
});

// ---- End to end -----------------------------------------------------------------------------------------------------------
test("USD export invoice, two agreeing readings: completed, exchange rate used", async () => {
  const pdf = minimalPdf();
  const cfg = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true };
  const saved = [];
  let t = Date.parse("2026-10-11T00:00:00Z");
  const res = { ok: true, text: JSON.stringify(usd()), usage: { inputTokens: 10, outputTokens: 10 } };
  const deps = {
    geminiConfig: cfg, maxPdfPages: 10, now: () => (t += 500), sleep: async () => {}, random: () => 0, log: () => {},
    files: { download: async () => pdf }, gemini: async () => res,
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { saved.push(a); return "ok"; } },
  };
  const r = await runExtraction(deps, { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) });
  assert.equal(r.outcome, "completed", JSON.stringify(saved[0]?.extracted.review_flags.map((x) => [x.code, x.severity, x.field])));
  assert.equal(saved[0].extracted.currency, "USD");
  assert.deepEqual(arith(saved[0].extracted.review_flags), []);
});

// ---- Discount: percentage vs flat amount ---------------------------------------------------------------------------------
// Level 6 case: 5 x 1200 USD, discount "5" means 5% -> 5700 USD -> 475,950.00 INR at 83.50 (NOT 6000 - 5).
const pct1 = (o = {}) => line1({ discount: f(5), taxable_value: f(475950), tax_amount: f(85671), line_total: f(561621), ...o });
const usdPct = (over = {}) => usd({ line_items: [pct1(), line2()], taxable_value: f(526050), igst: f(94689), cess: f(5260.5), grand_total: f(5260.5 + 94689 + 526050), ...over });

test("lineSteps: percent vs flat discount", () => {
  assert.deepEqual(lineSteps(5, 1200, 5, 83.5, "PERCENT"), { gross: 6000, net: 5700, taxable: 475950 });
  assert.deepEqual(lineSteps(5, 1200, 5, 83.5), { gross: 6000, net: 5995, taxable: 500582.5 });
  assert.deepEqual(lineSteps(3, 0.1, null, 1), { gross: 0.3, net: 0.3, taxable: 0.3 });
});

test("discount 5 read as 5% is accepted (printed rate)", () => {
  assert.deepEqual(arith(run(usdPct()).flags), []);
});

test("discount 5 read as 5% is accepted when the rate must be taken from the other lines", () => {
  const m = usdPct();
  delete m.exchange_rate;
  const r = run(m);
  assert.deepEqual(r.flags.filter((x) => x.code === "arithmetic_line_mismatch"), []);
});

test("flat discount above 100 still works, and a flat discount of 100 is not mistaken for 100%", () => {
  assert.deepEqual(arith(run(usd()).flags), []); // 100 flat -> 5900 USD
  assert.deepEqual(arith(run(usd({ line_items: [line1({ discount: f(250), taxable_value: f(480125) }), line2()], taxable_value: f(530225), igst: f(95440.5), cess: f(5302.25), grand_total: f(630967.75) })).flags), []);
});

test("a wrong value is still flagged when discount is a percentage", () => {
  const fl = run(usdPct({ line_items: [pct1({ taxable_value: f(470000) }), line2()] })).flags.find((x) => x.code === "arithmetic_line_mismatch");
  assert.ok(fl);
  assert.equal(fl.itemPosition, 1);
});

test("INR invoice with a percentage discount: 10 x 1000 less 5% = 9500", () => {
  const m = model({ line_items: [item({ quantity: f(10), unit_price: f(1000), discount: f(5), taxable_value: f(9500), tax_amount: f(1710), line_total: f(11210) })], taxable_value: f(9500), cgst: f(855), sgst: f(855), grand_total: f(11210) });
  assert.deepEqual(arith(run(m).flags), []);
});

test("explicit discount type is trusted over guessing", () => {
  const mk = (type, taxable) => [{ description: "x", hsn_code: null, quantity: 5, unit: null, unit_price: 1200, discount_amount: 5, discount_type: type, taxable_amount: taxable, gst_rate: 18, gst_amount: null, line_total: null, field_status: {} }];
  const ctx = { currency: "USD", exchangeRate: 83.5, tolerancePaise: 100 };
  assert.deepEqual(checkLineItems(mk("PERCENT", 475950), ctx), []);
  assert.equal(checkLineItems(mk("AMOUNT", 475950), ctx).length, 1); // 5 flat would give 500,582.50
  assert.deepEqual(checkLineItems(mk("AMOUNT", 500582.5), ctx), []);
});
