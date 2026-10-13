// Multi-tier total reconciliation: grand total (taxable + taxes + TCS) OR net payable (grand total - TDS), +/- INR 2.00 round-off.
// Also covers the four bottom-line summary fields: tcs_amount, tds_amount, round_off_amount, net_payable_amount.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice, validateInvoiceTotals } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { validateModelOutput, buildResponseSchema, BOTTOM_LINE_DESCRIPTIONS } from "../lib/extraction/schema.ts";
import { SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { BOTTOM_LINE_FIELDS, OPTIONAL_AMOUNT_FIELDS } from "../lib/extraction/types.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { f, missing, item, model, minimalPdf, sha } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const run = (m) => validateInvoice(norm(m), OPTS);
const totals = (m) => { const n = norm(m); return validateInvoiceTotals(n.extracted, n.items, OPTS); };
const problems = (r) => r.flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code);
const codes = (r) => r.flags.map((x) => x.code);

// Enterprise invoice: 100000 taxable + 9000 CGST + 9000 SGST = 118000.
//   with TCS 118 (0.1%):   Grand Total = 118118       (Tier 1)
//   with TDS 100 (0.1%):   Net Payable = 118018       (Tier 2, = Tier 1 - TDS)
const base = (over = {}) => model({
  taxable_value: f(100000), cgst: f(9000), sgst: f(9000), grand_total: f(118000),
  line_items: [item({ quantity: f(1), unit_price: f(100000), taxable_value: f(100000), tax_amount: f(18000), line_total: f(118000) })],
  ...over,
});

// ---- The reported bug -------------------------------------------------------------------------------------------------------

test("TDS printed as a separate deduction below an unchanged Grand Total no longer raises a false mismatch", () => {
  // Grand total 118000 (before TDS), TDS 100 deducted below it. The old formula expected 117900 and failed.
  const r = run(base({ tds_amount: f(100) }));
  assert.deepEqual(r.flags, []);
  assert.equal(r.valid, true);
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.total_tier, "grand_total");
  assert.equal(r.summary.expected_grand_total, 118000);
  assert.equal(r.summary.expected_net_payable, 117900);
});

test("a printed total that is already net of TDS still passes (Tier 2)", () => {
  const r = run(base({ tds_amount: f(100), grand_total: f(117900) }));
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.total_tier, "net_payable");
  assert.equal(r.summary.calculated_total, 117900);
});

test("TCS and TDS together: both the grand total and the net payable are accepted, a total that ignores TCS is not", () => {
  const withBoth = (grand) => base({ tcs_amount: f(118), tds_amount: f(100), grand_total: f(grand) });
  assert.deepEqual(problems(run(withBoth(118118))), []); // Tier 1: taxable + taxes + TCS
  assert.equal(totals(withBoth(118118)).matchedTier, "grand_total");
  assert.deepEqual(problems(run(withBoth(118018))), []); // Tier 2: Tier 1 - TDS
  assert.equal(totals(withBoth(118018)).matchedTier, "net_payable");
  const bad = run(withBoth(118000)); // TCS forgotten in the printed total, and not net either
  assert.deepEqual(codes(bad), ["arithmetic_total_mismatch"]);
  assert.equal(bad.flags[0].details.expected, 118118);
  assert.equal(bad.flags[0].details.expectedNetPayable, 118018);
  assert.equal(bad.summary.total_check, "failed");
});

test("TDS and TCS are applied by what they are, not by the sign they were printed with", () => {
  assert.deepEqual(problems(run(base({ tds_amount: f(-100), grand_total: f(117900) }))), []); // "(-) 100.00"
  assert.deepEqual(problems(run(base({ tcs_amount: f(-118), grand_total: f(118118) }))), []);
});

test("a TDS of zero does not open a second tier", () => {
  const t = totals(base({ tds_amount: f(0), grand_total: f(117900) }));
  assert.equal(t.passed, false);
  assert.equal(t.expectedNetPayable, null);
});

// ---- Round-off ------------------------------------------------------------------------------------------------------------

test("round-off up to INR 2.00 is absorbed on either tier, beyond that it is a mismatch", () => {
  const tier2 = (grand) => totals(base({ tds_amount: f(100), grand_total: f(grand) }));
  const small = tier2(117900.8);
  assert.equal(small.passed, true);
  assert.equal(small.matchedTier, "net_payable");
  assert.equal(small.roundOffApplied, 0.8);
  assert.equal(small.roundOffAbsorbed, 0.8);
  assert.equal(small.status, "VALIDATED");
  const edge = tier2(117902); // exactly 2.00
  assert.equal(edge.passed, true);
  assert.equal(edge.roundOffApplied, 2);
  const under = tier2(117898); // -2.00
  assert.equal(under.passed, true);
  assert.equal(under.roundOffApplied, -2);
  const over = tier2(117902.01); // 2.01 away from Tier 2 and 102.01 from Tier 1
  assert.equal(over.passed, false);
  assert.equal(over.status, "MISMATCH");
  assert.equal(over.roundOffAbsorbed, 0);
});

test("the closest tier wins when both are within reach", () => {
  const t = totals(base({ tds_amount: f(1), grand_total: f(117999.2) })); // 0.2 below Tier 2 (117999) ... 0.8 below Tier 1
  assert.equal(t.matchedTier, "net_payable");
  assert.equal(t.roundOffApplied, 0.2);
  const tie = totals(base({ tds_amount: f(1), grand_total: f(118000) })); // exact Tier 1
  assert.equal(tie.matchedTier, "grand_total");
  assert.equal(tie.roundOffApplied, null);
});

test("a printed round-off explains the difference and is never replaced by a computed one", () => {
  const explained = run(base({ tcs_amount: f(118.4), round_off_amount: f(-0.4), grand_total: f(118118) }));
  assert.deepEqual(problems(explained), []);
  assert.deepEqual(explained.patch, {});
  // 1.50 difference although 0.40 was printed: still passes, but the printed figure is not overwritten.
  const kept = run(base({ round_off_amount: f(0.4), grand_total: f(118001.5) }));
  assert.deepEqual(problems(kept), []);
  assert.deepEqual(kept.patch, {});
  assert.equal(kept.summary.round_off_applied, 1.5);
  // No printed round-off: the computed one is offered as a patch.
  assert.deepEqual(run(base({ grand_total: f(118001.5) })).patch, { round_off_amount: 1.5 });
});

// ---- net_payable_amount ---------------------------------------------------------------------------------------------------

test("net_payable_amount that equals grand total minus TDS is clean", () => {
  const r = run(base({ tcs_amount: f(118), tds_amount: f(100), grand_total: f(118118), net_payable_amount: f(118018) }));
  assert.deepEqual(r.flags, []);
});

test("net_payable_amount that is off by more than the round-off window is flagged", () => {
  const r = run(base({ tcs_amount: f(118), tds_amount: f(100), grand_total: f(118118), net_payable_amount: f(118050) }));
  assert.deepEqual(codes(r), ["net_payable_mismatch"]);
  assert.equal(r.flags[0].severity, "warning");
  assert.equal(r.flags[0].details.expected, 118018);
});

test("net_payable_amount within INR 2.00 of the expected figure is accepted as round-off", () => {
  assert.deepEqual(run(base({ tds_amount: f(100), net_payable_amount: f(117901.5) })).flags, []);
});

test("a printed total that is already net must equal net_payable_amount", () => {
  assert.deepEqual(run(base({ tds_amount: f(100), grand_total: f(117900), net_payable_amount: f(117900) })).flags, []);
  assert.deepEqual(codes(run(base({ tds_amount: f(100), grand_total: f(117900), net_payable_amount: f(117000) }))), ["net_payable_mismatch"]);
});

test("net payable lower than the grand total but no TDS read: an info note, not a warning", () => {
  const r = run(base({ net_payable_amount: f(117900) }));
  assert.deepEqual(codes(r), ["net_payable_tds_not_found"]);
  assert.equal(r.flags[0].severity, "info");
  assert.equal(r.flags[0].details.impliedDeduction, 100);
  assert.equal(r.valid, true);
});

test("a wrong grand total is still an error, and the flag says whether the printed net payable matches the calculation", () => {
  const r = run(base({ tds_amount: f(100), grand_total: f(130000), net_payable_amount: f(117900) }));
  assert.deepEqual(codes(r), ["arithmetic_total_mismatch"]);
  assert.equal(r.flags[0].severity, "error");
  assert.equal(r.flags[0].details.printedNetPayableMatchesCalculation, true);
});

test("net_payable_amount alone never turns a clean invoice into a problem", () => {
  assert.deepEqual(run(base({ net_payable_amount: f(118000) })).flags, []);
  assert.deepEqual(run(base({ net_payable_amount: missing() })).flags, []);
});

// ---- Result shape ---------------------------------------------------------------------------------------------------------

test("totals result carries the verdict spelled out; not enough data is NOT_CHECKED", () => {
  const ok = totals(base());
  assert.equal(ok.status, "VALIDATED");
  assert.equal(ok.passed, true);
  assert.equal(ok.matchedTier, "grand_total");
  assert.equal(ok.expectedGrandTotal, 118000);
  assert.equal(ok.roundOffAbsorbed, 0);
  const none = totals(base({ grand_total: missing() }));
  assert.equal(none.status, "NOT_CHECKED");
  assert.equal(none.passed, null);
  assert.equal(none.matchedTier, null);
});

test("the old strict check is gone from arithmetic.ts", async () => {
  const arithmetic = await import("../lib/extraction/arithmetic.ts");
  assert.equal(arithmetic.checkTotals, undefined);
});

// ---- Schema, prompt, normalisation ------------------------------------------------------------------------------------------

test("all four bottom-line fields are optional extras in the schema, described to the model, and read by the parser", () => {
  assert.deepEqual([...BOTTOM_LINE_FIELDS], ["tcs_amount", "tds_amount", "round_off_amount", "net_payable_amount"]);
  for (const k of BOTTOM_LINE_FIELDS) {
    assert.ok(OPTIONAL_AMOUNT_FIELDS.includes(k), `${k} is an optional amount field`);
    assert.ok(BOTTOM_LINE_DESCRIPTIONS[k].length > 20);
    assert.equal(buildResponseSchema().properties[k].description, BOTTOM_LINE_DESCRIPTIONS[k]);
    assert.ok(SYSTEM_PROMPT.includes(k), `${k} is named in the prompt`);
    assert.equal(validateModelOutput(model({ [k]: f(10) })).ok, true);
    assert.equal(validateModelOutput(model({ [k]: f("x") })).ok, false);
    assert.equal(validateModelOutput(model({ [k]: { status: "present", value: null, confidence: 1 } })).ok, false);
  }
  assert.ok(SYSTEM_PROMPT.includes("206C") && SYSTEM_PROMPT.includes("194Q"));
  assert.equal(validateModelOutput(model()).ok, true); // older readings without any of them stay valid
});

test("the parser stores the four fields; absent stays null and is never turned into 0", () => {
  const n = norm(model({ tcs_amount: f(118), tds_amount: f(100), round_off_amount: f(-0.4), net_payable_amount: f(118017.6) }));
  const e = n.extracted;
  assert.deepEqual([e.tcs_amount, e.tds_amount, e.round_off_amount, e.net_payable_amount], [118, 100, -0.4, 118017.6]);
  assert.equal(e.field_status.net_payable_amount.state, "value");
  const none = norm(model()).extracted;
  assert.deepEqual([none.tcs_amount, none.tds_amount, none.round_off_amount, none.net_payable_amount], [null, null, null, null]);
  assert.equal(norm(model({ net_payable_amount: f(0) })).extracted.field_status.net_payable_amount.state, "zero");
  assert.equal(norm(model({ net_payable_amount: missing() })).extracted.field_status.net_payable_amount.state, "missing");
});

// ---- End to end -----------------------------------------------------------------------------------------------------------

test("pipeline: an enterprise invoice with TCS, TDS and net payable is completed with no mismatch warning, and net payable is saved", async () => {
  const pdf = minimalPdf();
  const calls = { completes: [] };
  const deps = {
    geminiConfig: { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000 },
    maxPdfPages: 10, now: () => Date.parse("2026-10-11T00:00:00Z"), sleep: async () => {}, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async () => ({ ok: true, text: JSON.stringify(base({ tcs_amount: f(118), tds_amount: f(100), grand_total: f(118118), net_payable_amount: f(118018) })), usage: { inputTokens: 1, outputTokens: 1 } }),
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { calls.completes.push(a); return "ok"; } },
  };
  const r = await runExtraction(deps, { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) });
  assert.equal(r.outcome, "completed");
  const saved = calls.completes[0].extracted;
  assert.equal(saved.net_payable_amount, 118018);
  assert.equal(saved.tds_amount, 100);
  assert.equal(saved.tcs_amount, 118);
  assert.equal(saved.validation_summary.total_check, "passed");
  assert.equal(saved.validation_summary.total_tier, "grand_total");
  assert.ok(!saved.review_flags.some((x) => x.code === "arithmetic_total_mismatch"));
});
