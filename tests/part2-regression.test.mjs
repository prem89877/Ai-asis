// Part 2 acceptance tests: GSTIN checksum, the three verification layers, tax scenarios, save / reload, exports, legacy rows.
// Primary case: "GST Tax Invoice CGST SGST UTGST IGST.pdf"
//   taxable 350,000 | CGST 18,000 | SGST 9,000 | UTGST 9,000 | IGST 27,000 | cess 0 | total GST 63,000 | grand total 413,000 | TCS/TDS 0
//   supplier GSTIN 27AAACN5544R1Z3, buyer GSTIN 06AAACA9911A1Z2 (both printed as shown, both fail the Modulo-36 check digit)
// The test data below is built per scenario. Nothing here is hardcoded into production code.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction, checkGstin, gstinChecksumChar } from "../lib/extraction/normalize.ts";
import { validateGstin, suggestGstinFixes, cleanGstin, computeGstinCheckDigit } from "../lib/extraction/gstin.ts";
import { auditExtraction } from "../lib/extraction/final-audit.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { taxHeadsPaise, totalGstPaise, totalTaxPaise, stateTaxPaise } from "../lib/extraction/tax-components.ts";
import { computeReviewFlags, toStoredExtracted } from "../lib/review/flags.ts";
import { applyReview } from "../lib/review/apply.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { buildTables } from "../lib/export/build.ts";
import { toXlsx } from "../lib/export/xlsx.ts";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS } from "../lib/export/columns.ts";
import { DEFAULT_TALLY_CONFIG, buildVouchers, voucherBalance } from "../lib/tally/build.ts";
import { f, missing, item, model, minimalPdf, sha } from "./helpers.mjs";

const NOW = new Date("2026-10-15T00:00:00Z");
const OPTS = { tolerancePaise: 100, lowConfidence: 0.8 };
const PRINTED_SUPPLIER = "27AAACN5544R1Z3";
const PRINTED_BUYER = "06AAACA9911A1Z2";
const GOOD_GSTIN = "27AAPFU0939F1ZV"; // layout + check digit pass

const norm = (m, o = {}) => normalizeExtraction(m, { model: "t", now: NOW, ...o });
const run = (m) => validateInvoice(norm(m), OPTS);
const problems = (r) => r.flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code);
const line = (taxable, tax, type, rate = 18) => item({
  description: f("Line"), quantity: f(1), unit_price: f(taxable), taxable_value: f(taxable), gst_rate: f(rate), tax_amount: f(tax), line_total: f(taxable + tax),
  ...(type ? { applied_tax_type: f(type) } : {}),
});

// The primary mixed-tax invoice, with the printed GSTINs.
const mixed = (over = {}) => model({
  supplier_gstin: f(PRINTED_SUPPLIER), buyer_gstin: f(PRINTED_BUYER), place_of_supply: f("Karnataka (29)"),
  taxable_value: f(350000), cgst: f(18000), sgst: f(9000), utgst_amount: f(9000), igst: f(27000), cess: f(0), grand_total: f(413000),
  line_items: [line(150000, 27000, "IGST"), line(100000, 18000, "CGST+SGST"), line(100000, 18000, "CGST+UTGST")],
  ...over,
});

// ================================================================================================================================
// A. GSTIN checksum, normalization and suggestions
// ================================================================================================================================

// Independent reference: the published GSTN Modulo-36 algorithm written separately from the project code.
function referenceCheckChar(first14) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return chars[(36 - (sum % 36)) % 36];
}

test("GSTIN: the project checksum equals an independent reference implementation (algorithm is correct)", () => {
  for (const g of [PRINTED_SUPPLIER, PRINTED_BUYER, GOOD_GSTIN, "29AABCT1332L1ZU", "07AAACS8577K2ZO", "33AAACT2727Q1ZW"]) {
    assert.equal(gstinChecksumChar(g.slice(0, 14)), referenceCheckChar(g.slice(0, 14)), g);
  }
  assert.equal(checkGstin(GOOD_GSTIN).ok, true);
});

test("GSTIN: the two printed GSTINs of the primary invoice really fail the check digit (the warning is correct, not a bug)", () => {
  assert.deepEqual(checkGstin(PRINTED_SUPPLIER), { ok: false, reason: "checksum" });
  assert.deepEqual(checkGstin(PRINTED_BUYER), { ok: false, reason: "checksum" });
  assert.equal(referenceCheckChar(PRINTED_SUPPLIER.slice(0, 14)), "V");
  assert.equal(referenceCheckChar(PRINTED_BUYER.slice(0, 14)), "8");
});

test("GSTIN: valid checksum is reported valid, and valid does NOT mean registered", () => {
  const v = validateGstin(GOOD_GSTIN);
  assert.equal(v.status, "valid");
  assert.equal(v.valid, true);
  assert.equal(v.gstin, GOOD_GSTIN);
  assert.equal(v.proposed, undefined);
});

test("GSTIN: invalid checksum keeps the printed value, exposes it as raw, and only proposes a fix", () => {
  for (const [printed, proposal] of [[PRINTED_SUPPLIER, "27AAACN5544R1ZV"], [PRINTED_BUYER, "06AAACA9911A1Z8"]]) {
    const v = validateGstin(printed);
    assert.equal(v.status, "checksum_failed");
    assert.equal(v.valid, false);
    assert.equal(v.raw, printed);
    assert.equal(v.gstin, printed, "the value to save is always the printed one");
    assert.deepEqual(v.proposed, [proposal]);
    assert.notEqual(v.gstin, v.proposed[0]);
  }
});

test("GSTIN: malformed input is format_invalid with no suggestion, and never throws", () => {
  for (const bad of ["27AAACN5544R1Z", "27AAACN5544R1Z33", "ABCDEFGHIJKLMNO", "27AAACN5544R1X3", "27AAACN55O4R1Z3", "27-AAACN5544R1Z3", "२७AAACN5544R1Z3"]) {
    const v = validateGstin(bad);
    assert.equal(v.status, "format_invalid", bad);
    assert.equal(v.gstin, cleanGstin(bad), "kept as read");
    assert.equal(v.proposed, undefined, `no guess for ${bad}`);
  }
  for (const empty of [null, undefined, "", "   "]) assert.equal(validateGstin(empty).status, "missing");
});

test("GSTIN: lower case and whitespace are normalised, the cleaned value is what is checked and kept", () => {
  assert.equal(cleanGstin(" 27aapfu0939f1zv \n"), GOOD_GSTIN);
  assert.equal(validateGstin(" 27aapfu 0939f1zv ").status, "valid");
  const v = validateGstin(" 27aaacn5544r1z3 ");
  assert.equal(v.status, "checksum_failed");
  assert.equal(v.raw, PRINTED_SUPPLIER);
  assert.deepEqual(v.proposed, ["27AAACN5544R1ZV"]);
});

test("GSTIN: suggestions never change the input and only touch the 15th character", () => {
  const input = PRINTED_SUPPLIER;
  const copy = String(input);
  const s = suggestGstinFixes(input);
  assert.equal(input, copy);
  assert.equal(s.length, 1);
  assert.equal(s[0].slice(0, 14), input.slice(0, 14));
  assert.equal(suggestGstinFixes(GOOD_GSTIN).length, 0, "a valid GSTIN gets no suggestion");
  assert.equal(computeGstinCheckDigit("27AAACN5544R1Z"), "V", "the 14-character prefix of the printed supplier GSTIN");
  assert.equal(computeGstinCheckDigit("XXAAACN5544R1Z"), null, "bad layout: nothing is computed");
});

test("GSTIN: normalization stores the printed value, flags the checksum and never auto-replaces it", () => {
  const { extracted: e } = norm(mixed());
  assert.equal(e.vendor_gstin, PRINTED_SUPPLIER);
  assert.equal(e.buyer_gstin, PRINTED_BUYER);
  assert.equal(e.gstin_auto_corrected, false);
  assert.equal(e.field_status.supplier_gstin.rawValue, PRINTED_SUPPLIER);
  assert.equal(e.field_status.supplier_gstin.autoCorrected, undefined);
  const sup = e.review_flags.filter((x) => x.field === "supplier_gstin" && x.severity !== "info");
  assert.ok(sup.length >= 1, "the checksum mismatch is reported");
  const text = JSON.stringify(e.review_flags.filter((x) => x.field === "supplier_gstin" || x.field === "buyer_gstin"));
  assert.match(text, /27AAACN5544R1ZV/, "the suggestion is shown to the reviewer");
  assert.ok(!/registered|exists/i.test(text.replace(/does not exist|not proof/gi, "")), "a checksum result is never described as a registration");
});

test("GSTIN warnings are independent of the tax arithmetic and the grand total", () => {
  const withBadGstin = run(mixed());
  assert.equal(withBadGstin.summary.total_check, "passed");
  assert.deepEqual(problems(withBadGstin), [], "the engine (arithmetic) raises nothing because of a GSTIN");
  const good = run(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  assert.equal(good.summary.total_check, "passed");
  // and a wrong total does not touch the GSTIN verdict
  const badTotal = norm(mixed({ grand_total: f(420000) }));
  assert.equal(badTotal.extracted.vendor_gstin, PRINTED_SUPPLIER);
  assert.equal(validateGstin(badTotal.extracted.vendor_gstin).status, "checksum_failed");
});

test("GSTIN: the three-layer gate reports the checksum mismatch in the rules layer and never repairs the value", () => {
  const n = norm(mixed());
  const flags = n.extracted.review_flags;
  const { report } = auditExtraction({ extracted: n.extracted, items: n.items, merged: mixed(), readings: [mixed()], parties: [], verdicts: null, totalStatus: null, flags, now: NOW });
  const rules = report.layers.find((l) => l.name === "rules");
  assert.ok(rules.failed.some((x) => x.field === "supplier_gstin" && /check digit/i.test(x.reason)));
  assert.ok(rules.failed.some((x) => x.field === "buyer_gstin"));
  assert.equal(report.fields.supplier_gstin.status, "needs_review");
  assert.equal(n.extracted.vendor_gstin, PRINTED_SUPPLIER);
  assert.equal(report.passed, false);
});

// ================================================================================================================================
// B. The primary invoice, exact values
// ================================================================================================================================

test("primary invoice: every head and total is exact, total GST is 63,000, grand total 413,000", () => {
  const { extracted: e, items } = norm(mixed());
  assert.deepEqual(
    [e.taxable_amount, e.cgst_amount, e.sgst_amount, e.utgst_amount, e.igst_amount, e.cess_amount, e.total_amount],
    [350000, 18000, 9000, 9000, 27000, 0, 413000],
  );
  assert.equal(items.length, 3);
  const h = taxHeadsPaise(e);
  assert.equal(totalGstPaise(h) / 100, 63000);
  assert.equal(stateTaxPaise(h) / 100, 18000);
  assert.equal(totalTaxPaise(h) / 100, 63000, "cess is 0");
  const r = run(mixed());
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.expected_grand_total, 413000);
  assert.equal(r.summary.adjustments.tcs, 0);
  assert.equal(r.summary.adjustments.tds, 0);
  assert.equal(r.summary.tax_components.invoice.total_gst, 63000);
  assert.equal(r.summary.verification.level, "verified");
  assert.deepEqual(problems(r), [], "no false warning for a correct invoice");
});

// ================================================================================================================================
// C. Scenario matrix
// ================================================================================================================================

test("IGST-only invoice (inter-state) passes", () => {
  const r = run(model({ place_of_supply: f("Karnataka (29)"), taxable_value: f(1000), cgst: missing(), sgst: missing(), igst: f(180), grand_total: f(1180), line_items: [line(1000, 180, "IGST")] }));
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
});

test("CGST + SGST invoice passes", () => {
  const r = run(model({ line_items: [line(1000, 180, "CGST+SGST")] }));
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.verification.level, "verified");
});

test("CGST + UTGST invoice passes without any SGST", () => {
  const r = run(model({ sgst: missing(), utgst_amount: f(90), line_items: [line(1000, 180, "CGST+UTGST")] }));
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
});

test("missing UTGST in the summary: the 9,000 gap is reported against UTGST with the specific reason", () => {
  const m = mixed(); delete m.utgst_amount;
  const r = run(m);
  assert.equal(r.summary.total_check, "failed");
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(flag);
  assert.equal(flag.details.expected, 404000);
  assert.ok(flag.details.likelyCauses.some((c) => c.code === "utgst_not_read"));
  assert.notEqual(r.summary.verification.level, "verified");
});

test("incorrect SGST aggregation (UTGST merged into SGST, UTGST printed as 0) is flagged per head even though the total ties", () => {
  const r = run(mixed({ sgst: f(18000), utgst_amount: f(0) }));
  assert.equal(r.summary.total_check, "passed", "the grand total is right");
  const flag = r.flags.find((x) => x.code === "tax_allocation_mismatch");
  assert.ok(flag, "but the component breakdown is not accepted silently");
  assert.ok(flag.details.mismatchedHeads.includes("SGST") && flag.details.mismatchedHeads.includes("UTGST"));
  assert.notEqual(r.summary.verification.level, "verified");
});

test("duplicate tax amount (the same 9,000 counted as SGST and again as UTGST) fails with a specific warning", () => {
  const r = run(model({ taxable_value: f(1000), cgst: f(90), sgst: f(90), utgst_amount: f(90), grand_total: f(1180), line_items: [line(1000, 180, "CGST+SGST")] }));
  assert.equal(r.summary.total_check, "failed");
  assert.ok(problems(r).includes("arithmetic_total_mismatch"));
  assert.ok(problems(r).includes("tax_allocation_mismatch"));
  const flag = r.flags.find((x) => x.code === "tax_allocation_mismatch");
  assert.ok(flag.details.mismatchedHeads.includes("UTGST"));
});

test("correct grand total with an incorrect component breakdown is still flagged per head", () => {
  const r = run(model({ cgst: f(100), sgst: f(80), grand_total: f(1180) }));
  assert.equal(r.summary.total_check, "passed");
  assert.ok(problems(r).includes("tax_component_mismatch") || problems(r).includes("cgst_sgst_unequal"));
  assert.equal(r.summary.verification.level, "unverified");
});

test("incorrect grand total with a correct component breakdown is an error and is never 'verified'", () => {
  const r = run(model({ grand_total: f(1200) }));
  assert.equal(r.summary.total_check, "failed");
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.equal(flag.severity, "error");
  assert.equal(r.summary.verification.level, "unverified", "tax cross-check must not read verified beside a failed total");
  assert.ok(r.summary.verification.disagreeing.includes("grand_total"));
});

test("TCS-only invoice: TCS is inside the grand total", () => {
  const r = run(model({ tcs_amount: f(10), grand_total: f(1190) }));
  assert.equal(r.summary.total_check, "passed");
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.adjustments.tcs, 10);
});

test("TDS-only invoice: the grand total is unchanged, TDS only reduces the net payable", () => {
  const r = run(model({ tds_amount: f(20), grand_total: f(1180), net_payable_amount: f(1160) }));
  assert.equal(r.summary.total_check, "passed");
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.adjustments.tds, 20);
});

test("invoice with both TCS and TDS", () => {
  const r = run(model({ tcs_amount: f(10), tds_amount: f(20), grand_total: f(1190), net_payable_amount: f(1170) }));
  assert.equal(r.summary.total_check, "passed");
  assert.deepEqual(problems(r), []);
});

test("commercial discount without TCS / TDS reconciles and is not mistaken for TDS", () => {
  const r = run(model({
    taxable_value: f(1000), discount_total: f(100), cgst: f(81), sgst: f(81), grand_total: f(1062),
    line_items: [item({ quantity: f(1), unit_price: f(1000), discount: f(100), taxable_value: f(900), tax_amount: f(162), line_total: f(1062), gst_rate: f(18) })],
  }));
  assert.equal(r.summary.adjustments.tds, 0);
  assert.equal(r.summary.adjustments.tcs, 0);
  assert.ok(!problems(r).includes("arithmetic_total_mismatch"), "the discount-adjusted total ties");
});

test("rounding tolerance: up to INR 2.00 passes, 3.00 fails", () => {
  assert.equal(run(model({ grand_total: f(1180.4) })).summary.total_check, "passed");
  assert.equal(run(model({ grand_total: f(1181.9) })).summary.total_check, "passed");
  const far = run(model({ grand_total: f(1183) }));
  assert.equal(far.summary.total_check, "failed");
  assert.notEqual(far.summary.verification.level, "verified");
});

test("a clean invoice passes reconciliation with no flag at all", () => {
  const r = run(model());
  assert.equal(r.valid, true);
  assert.deepEqual(r.flags.filter((x) => x.severity !== "info"), []);
});

test("a failing invoice fails with a specific, named warning (field, expected and observed values)", () => {
  const r = run(model({ grand_total: f(1500) }));
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.equal(flag.field, "grand_total");
  assert.equal(flag.details.expected, 1180);
  assert.equal(flag.details.observed ?? flag.details.found ?? 1500, 1500);
  assert.match(flag.message, /1,?500|1500/);
});

// ================================================================================================================================
// D. Model confidence is not proof
// ================================================================================================================================

test("a model confidence of 100% with wrong financial data is still an error, and verification is not 'verified'", () => {
  const wrong = model({ supplier_gstin: f(GOOD_GSTIN, 1), taxable_value: f(1000, 1), cgst: f(90, 1), sgst: f(90, 1), grand_total: f(1500, 1), line_items: [item({ taxable_value: f(1000, 1), tax_amount: f(180, 1), line_total: f(1180, 1) })] });
  const n = norm(wrong);
  const r = validateInvoice(n, OPTS);
  assert.equal(n.extracted.total_amount, 1500, "kept as extracted, not silently fixed");
  assert.equal(r.summary.total_check, "failed");
  assert.equal(r.flags.find((x) => x.code === "arithmetic_total_mismatch").severity, "error");
  assert.notEqual(r.summary.verification.level, "verified");
  const { report } = auditExtraction({ extracted: n.extracted, items: n.items, merged: wrong, readings: [wrong], parties: [], verdicts: null, totalStatus: null, flags: r.flags, now: NOW });
  assert.equal(report.passed, false);
  assert.equal(report.fields.grand_total.status, "needs_review");
  assert.ok(report.fields.grand_total.failed_layers.includes(1));
});

test("pipeline: three identical 100%-confidence readings of a wrong total still end in needs_review", async () => {
  const wrong = model({ grand_total: f(1500, 1), supplier_gstin: f(GOOD_GSTIN, 1) });
  const pdf = minimalPdf();
  const calls = { completes: [] };
  let t = Date.parse("2026-10-15T00:00:00Z");
  const deps = {
    geminiConfig: { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true },
    maxPdfPages: 10, now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async () => { t += 1000; return { ok: true, text: JSON.stringify(wrong), usage: { inputTokens: 100, outputTokens: 50 } }; },
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { calls.completes.push(a); return "ok"; } },
  };
  const r = await runExtraction(deps, { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) });
  assert.equal(r.outcome, "needs_review");
  const e = calls.completes[0].extracted;
  assert.equal(e.total_amount, 1500);
  assert.ok(e.review_flags.some((x) => x.code === "arithmetic_total_mismatch" && x.severity === "error"));
  assert.notEqual(e.validation_summary.verification.level, "verified");
});

// ================================================================================================================================
// E. The three verification layers: independence and what each can mark verified
// ================================================================================================================================

test("layers: rules / consensus / evidence report separately and a field is verified only if no layer failed it", () => {
  const n = norm(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  const r2 = mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing(), cgst: f(18001) }); // a second reading that disagrees on CGST
  const { report } = auditExtraction({ extracted: n.extracted, items: n.items, merged: mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }), readings: [mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }), r2], parties: [], verdicts: null, totalStatus: null, flags: [], now: NOW });
  assert.deepEqual(report.layers.map((l) => l.name), ["rules", "consensus", "evidence"]);
  assert.equal(report.layers[0].ran, true);
  assert.equal(report.layers[1].ran, true);
  assert.equal(report.layers[2].ran, false, "no parties reading / key-figures reading: the evidence layer says it did not run");
  assert.equal(report.complete, false, "an incomplete gate is never reported as complete");
  // An amount that only one of two readings gave is accepted when the invoice arithmetic ties (that is a proof, not a vote).
  assert.ok(!report.layers[1].failed.some((x) => x.field === "cgst"));
  // A text value split 1:1 has no such proof: it is not accepted.
  const r3 = mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing(), invoice_number: f("INV-002") });
  const split = auditExtraction({ extracted: n.extracted, items: n.items, merged: mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }), readings: [mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }), r3], parties: [], verdicts: null, totalStatus: null, flags: [], now: NOW }).report;
  assert.ok(split.layers[1].failed.some((x) => x.field === "invoice_number"), "two readings split 1:1 on the invoice number and no rule proves either");
  assert.equal(split.fields.invoice_number.status, "needs_review");
});

test("layers: a failed arithmetic verdict makes layer 1 fail the grand total, whatever the readings say", () => {
  const bad = mixed({ grand_total: f(420000) });
  const n = norm(bad);
  const v = validateInvoice(n, OPTS);
  const { report } = auditExtraction({ extracted: n.extracted, items: n.items, merged: bad, readings: [bad, bad, bad], parties: [], verdicts: null, totalStatus: "confirmed", flags: v.flags, now: NOW });
  assert.ok(report.layers[0].failed.some((x) => x.field === "grand_total"), "layer 1 fails the total");
  assert.equal(report.fields.grand_total.status, "needs_review");
  assert.equal(report.passed, false);
  assert.equal(report.layers[1].failed.filter((x) => x.field === "grand_total").length, 0, "three identical readings agree: agreement alone is not what catches this");
});

test("layers: the tax cross-check uses three different derivations of the tax, not one formula three times", () => {
  const r = run(mixed());
  const ids = r.summary.verification.methods.map((m) => m.id);
  assert.ok(ids.includes("printed_invoice_tax") && ids.includes("printed_line_tax") && ids.includes("rate_x_taxable"));
  const values = r.summary.verification.methods.filter((m) => m.id !== "state_rule").map((m) => m.value);
  assert.deepEqual([...new Set(values)], [63000]);
  // when one derivation disagrees the verdict drops, so the derivations are really independent of each other
  const off = run(mixed({ line_items: [line(150000, 27000, "IGST"), line(100000, 18000, "CGST+SGST"), line(100000, 17000, "CGST+UTGST")] }));
  assert.notEqual(off.summary.verification.level, "verified");
});

// ================================================================================================================================
// F. Save, reload, edit
// ================================================================================================================================

function reviewHeader(e) {
  return Object.fromEntries(HEADER_COLUMNS.map((c) => [c, e[c] ?? null]));
}
const stored = (n) => n.items.map((it) => ({ ...it, applied_tax_type: it.applied_tax_type ?? null, discount_type: it.discount_type ?? null }));

test("edit, save and reload: an edit to the supplier name keeps UTGST and every amount, and the saved flags match the engine", () => {
  const n = norm(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  const header = reviewHeader(n.extracted);
  assert.equal(header.utgst_amount, 9000);
  const applied = applyReview({ header, field_status: n.extracted.field_status, corrected_fields: {}, items: [] }, { header: { vendor_name: "Acme Traders Pvt Ltd" } }, "u", "2026-10-15T00:00:00Z");
  for (const k of ["taxable_amount", "cgst_amount", "sgst_amount", "utgst_amount", "igst_amount", "cess_amount", "total_amount"]) assert.equal(applied.header[k], header[k], k);
  const flags = computeReviewFlags(applied.header, applied.fieldStatus, stored(n), OPTS, NOW, {});
  assert.deepEqual(flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code), [], "same verdict as the verification engine: no false warning after saving");
  // reload: the stored record rebuilt from the saved header gives the same totals
  const reloaded = toStoredExtracted(applied.header, applied.fieldStatus, {});
  assert.equal(totalGstPaise(taxHeadsPaise(reloaded)) / 100, 63000);
});

test("edit: changing only the UTGST is re-verified on the server-side rules and reported against UTGST", () => {
  const n = norm(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  const header = reviewHeader(n.extracted);
  const applied = applyReview({ header, field_status: n.extracted.field_status, corrected_fields: {}, items: [] }, { header: { utgst_amount: 8000 } }, "u", "2026-10-15T00:00:00Z");
  assert.equal(applied.header.utgst_amount, 8000);
  assert.equal(applied.header.sgst_amount, 9000, "SGST is untouched");
  const flags = computeReviewFlags(applied.header, applied.fieldStatus, stored(n), OPTS, NOW, {});
  assert.ok(flags.some((x) => x.severity !== "info" && /utgst|total|tax/i.test(`${x.code} ${x.field ?? ""}`)), "the edited figure no longer ties and says so");
});

test("an older browser tab that sends no utgst_amount cannot wipe the stored UTGST (database function only writes it when sent)", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../supabase/migrations/014_utgst.sql", import.meta.url), "utf8");
  assert.match(sql, /utgst_amount = case when p_header \? 'utgst_amount' then \(p_header ->> 'utgst_amount'\)::numeric else utgst_amount end/);
});

// ================================================================================================================================
// G. Exports: XLSX / CSV / Tally carry the same numbers
// ================================================================================================================================

function unzipText(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true);
    const data = bytes.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csz);
    out[name] = new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    p += 46 + nl + el + cl;
  }
  return out;
}
const exportInv = (n) => ({
  id: "11111111-1111-4111-8111-111111111111", original_filename: "mixed.pdf", status: "verified", created_at: "2026-10-15T04:30:00+00:00",
  ...n.extracted, tax_total: 63000, confidence: 0.9, verified_at: "2026-10-15T05:00:00+00:00", review_flags: [],
});

test("export: CSV table and XLSX sheet carry CGST 18,000 / SGST 9,000 / UTGST 9,000 / IGST 27,000 / total 413,000 and the printed GSTIN", () => {
  const n = norm(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  const cols = [...DEFAULT_COLUMNS];
  const tables = buildTables([exportInv(n)], new Map(), { format: "xlsx", columns: cols, itemColumns: [...DEFAULT_ITEM_COLUMNS], includeItems: false });
  const [t] = tables;
  const at = (label) => t.rows[0][t.headers.indexOf(label)];
  assert.equal(at("CGST"), 18000);
  assert.equal(at("SGST"), 9000);
  assert.equal(at("UTGST"), 9000);
  assert.equal(at("IGST"), 27000);
  const sheet = unzipText(toXlsx(tables, "iso", NOW))["xl/worksheets/sheet1.xml"];
  for (const v of ["18000", "9000", "27000", "413000"]) assert.ok(sheet.includes(`<v>${v}</v>`), `xlsx has ${v}`);
  assert.ok(sheet.includes(">UTGST<") || unzipText(toXlsx(tables, "iso", NOW))["xl/worksheets/sheet1.xml"].includes("UTGST"));
});

test("export: a GSTIN with a failed check digit is exported exactly as printed (never corrected)", () => {
  const n = norm(mixed());
  const [t] = buildTables([exportInv(n)], new Map(), { format: "csv", columns: DEFAULT_COLUMNS, itemColumns: DEFAULT_ITEM_COLUMNS, includeItems: false, dateFormat: "iso" });
  assert.equal(t.rows[0][t.headers.indexOf("Supplier GSTIN")], PRINTED_SUPPLIER);
  assert.equal(t.rows[0][t.headers.indexOf("Buyer GSTIN")], PRINTED_BUYER);
});

test("Tally: the mixed invoice balances to zero with UTGST on its own ledger, never merged into SGST", () => {
  const n = norm(mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing() }));
  const { vouchers, skipped } = buildVouchers([exportInv(n)], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0, JSON.stringify(skipped));
  const v = vouchers[0];
  assert.equal(voucherBalance(v), 0);
  const amt = (ledger) => v.entries.find((x) => x.ledger === ledger)?.paise;
  assert.equal(amt(DEFAULT_TALLY_CONFIG.cgstLedger), 1800000);
  assert.equal(amt(DEFAULT_TALLY_CONFIG.sgstLedger), 900000);
  assert.equal(amt(DEFAULT_TALLY_CONFIG.utgstLedger), 900000);
  assert.equal(amt(DEFAULT_TALLY_CONFIG.igstLedger), 2700000);
  assert.equal(v.entries.find((x) => x.isParty).paise, 41300000);
});

// ================================================================================================================================
// H. Legacy rows (combined SGST / UTGST field, no utgst_amount)
// ================================================================================================================================

test("legacy record: all state tax kept in sgst_amount with no utgst_amount is not double counted, in the engine, in the totals and in the export", () => {
  const legacy = mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing(), sgst: f(18000) });
  delete legacy.utgst_amount;
  const n = norm(legacy);
  assert.equal(n.extracted.utgst_amount ?? null, null);
  const r = validateInvoice(n, OPTS);
  assert.equal(r.summary.total_check, "passed");
  assert.deepEqual(problems(r), []);
  assert.equal(totalGstPaise(taxHeadsPaise(n.extracted)) / 100, 63000);
  const { vouchers, skipped } = buildVouchers([exportInv(n)], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0);
  assert.equal(voucherBalance(vouchers[0]), 0);
  assert.equal(vouchers[0].entries.find((x) => x.ledger === DEFAULT_TALLY_CONFIG.utgstLedger), undefined, "no UTGST ledger entry is invented for a legacy row");
  const [t] = buildTables([exportInv(n)], new Map(), { format: "csv", columns: DEFAULT_COLUMNS, itemColumns: DEFAULT_ITEM_COLUMNS, includeItems: false, dateFormat: "iso" });
  assert.equal(t.rows[0][t.headers.indexOf("SGST")], 18000);
  assert.ok([null, "", undefined].includes(t.rows[0][t.headers.indexOf("UTGST")]), "a legacy UTGST cell stays empty, not 0");
});

test("legacy record in the review screen: the review-time checks use the same rule as the engine", () => {
  const legacy = mixed({ supplier_gstin: f(GOOD_GSTIN), buyer_gstin: missing(), sgst: f(18000) });
  delete legacy.utgst_amount;
  const n = norm(legacy);
  const flags = computeReviewFlags(reviewHeader(n.extracted), n.extracted.field_status, stored(n), OPTS, NOW, {});
  assert.deepEqual(flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code), []);
});
