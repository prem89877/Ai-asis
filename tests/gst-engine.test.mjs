// GST validation engine: standard intra/inter-state, multi-currency, mixed IGST + CGST/SGST, TCS/TDS/charges/round-off,
// multi-slab, credit notes and negative lines, e-invoice metadata, GSTIN auto-repair, new fields in the schema.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice, validateInvoiceTotals, validateLineItem, validateTaxAllocation, slabSummary } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { runChecks } from "../lib/extraction/checks.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";
import { f, missing, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m, extra = {}) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11"), ...extra });
const run = (m) => validateInvoice(norm(m), OPTS);
const problems = (r) => r.flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code);
const codes = (r) => r.flags.map((x) => x.code);
const inter = { place_of_supply: f("Karnataka (29)"), cgst: missing(), sgst: missing() };

// ---- Standard Indian invoices ------------------------------------------------------------------------------------------

test("standard intra-state invoice: no flags, four independent methods agree", () => {
  const r = run(model());
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.verification.level, "verified");
  assert.deepEqual(r.summary.verification.methods.map((m) => m.id), ["printed_invoice_tax", "printed_line_tax", "rate_x_taxable", "state_rule"]);
});

test("standard inter-state invoice (IGST): clean and verified", () => {
  const r = run(model({ ...inter, igst: f(180) }));
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.verification.level, "verified");
});

test("IGST printed although supplier and place of supply are in the same state: the state rule disagrees, so it is not 'verified'", () => {
  const r = run(model({ cgst: missing(), sgst: missing(), igst: f(180) }));
  assert.equal(r.summary.verification.level, "unverified");
  assert.deepEqual(r.summary.verification.disagreeing, ["state_rule"]);
});

test("a tax that disagrees between the invoice and its lines is never shown as verified", () => {
  const r = run(model({ cgst: f(100), sgst: f(100), grand_total: f(1200) }));
  assert.equal(r.summary.verification.level, "unverified");
  assert.ok(r.summary.verification.disagreeing.includes("printed_line_tax"));
});

// ---- Multi-currency ----------------------------------------------------------------------------------------------------

const usdItem = (over = {}) => item({ quantity: f(10), unit_price: f(100), discount: f(10), discount_type: f("PERCENT"), taxable_value: f(74700), gst_rate: f(18), tax_amount: f(13446), line_total: f(88146), ...over });
const usd = (over = {}) => model({ currency: f("USD"), exchange_rate: f(83), ...inter, taxable_value: f(74700), igst: f(13446), grand_total: f(88146), line_items: [usdItem()], ...over });

test("USD invoice: 10% discount, then x 83 exchange rate, matches the INR taxable value", () => {
  const r = run(usd());
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.exchange_rate, 83);
  assert.equal(r.summary.currency, "USD");
});

test("USD invoice converted with the wrong rate is flagged on the line", () => {
  const r = run(usd({ exchange_rate: f(80) }));
  assert.ok(codes(r).includes("arithmetic_line_mismatch"));
});

test("EUR invoice: flat discount 50 on 5 x 200 = 950 EUR, x 90 = INR 85,500", () => {
  const eur = item({ quantity: f(5), unit_price: f(200), discount: f(50), discount_type: f("FLAT"), taxable_value: f(85500), tax_amount: f(15390), line_total: f(100890) });
  const r = run(model({ currency: f("EUR"), exchange_rate: f(90), ...inter, taxable_value: f(85500), igst: f(15390), grand_total: f(100890), line_items: [eur] }));
  assert.deepEqual(problems(r), []);
  // the same figures read as a 50% discount would not reproduce the printed taxable value
  const wrong = run(model({ currency: f("EUR"), exchange_rate: f(90), ...inter, taxable_value: f(85500), igst: f(15390), grand_total: f(100890), line_items: [{ ...eur, discount_type: f("PERCENT") }] }));
  assert.ok(codes(wrong).includes("arithmetic_line_mismatch"));
});

test("an INR invoice without a printed rate is treated as exchange rate 1.0", () => {
  const n = norm(model());
  assert.equal(n.extracted.exchange_rate, 1);
  assert.equal(validateInvoice(n, OPTS).summary.exchange_rate, 1);
});

test("a foreign currency without a printed rate is NOT given a rate", () => {
  const n = norm(model({ currency: f("USD") }));
  assert.equal(n.extracted.exchange_rate, null);
});

test("validateLineItem: soft tolerance of INR 1.00, percent and flat discounts", () => {
  const rc = { tolerancePaise: 100, foreign: false, explicitRate: null, impliedRate: null };
  const base = { description: null, hsn_code: null, unit: null, gst_rate: null, gst_amount: null, line_total: null, field_status: {} };
  const line = (o) => ({ ...base, quantity: 10, unit_price: 99.99, discount_amount: null, taxable_amount: 999.9, ...o });
  assert.equal(validateLineItem(line({ taxable_amount: 1000.5 }), 1, rc).status, "pass"); // 0.60 off
  assert.equal(validateLineItem(line({ taxable_amount: 1001 }), 1, rc).status, "fail"); // 1.10 off
  assert.equal(validateLineItem({ ...line({}), quantity: 4, unit_price: 250, discount_amount: 10, discount_type: "PERCENT", taxable_amount: 900 }, 1, rc).status, "pass");
  assert.equal(validateLineItem({ ...line({}), quantity: 4, unit_price: 250, discount_amount: 10, discount_type: "FLAT", taxable_amount: 990 }, 1, rc).status, "pass");
  assert.equal(validateLineItem({ ...line({}), quantity: null }, 1, rc).status, "skipped");
});

// ---- Mixed IGST + CGST/SGST ---------------------------------------------------------------------------------------------

// Goods moved between states on IGST + local installation on CGST/SGST, both at 18%.
const goods = (over = {}) => item({ description: f("Machine"), quantity: f(1), unit_price: f(10000), taxable_value: f(10000), gst_rate: f(18), tax_amount: f(1800), line_total: f(11800), ...over });
const install = (over = {}) => item({ description: f("Installation"), hsn_sac: f("9987"), quantity: f(1), unit_price: f(2000), taxable_value: f(2000), gst_rate: f(18), tax_amount: f(360), line_total: f(2360), ...over });
const mixed = (over = {}, lines = [goods(), install()]) => model({ taxable_value: f(12000), igst: f(1800), cgst: f(180), sgst: f(180), grand_total: f(14160), line_items: lines, ...over });

test("mixed tax, lines labelled: allowed, no blanket 'invalid tax' warning, only an information note", () => {
  const r = run(mixed({}, [goods({ applied_tax_type: f("IGST") }), install({ applied_tax_type: f("CGST_SGST") })]));
  assert.deepEqual(problems(r), []);
  assert.deepEqual(codes(r), ["mixed_tax_invoice"]);
  assert.equal(r.summary.tax_allocation.method, "labelled");
});

test("mixed tax, lines NOT labelled: the one split that reproduces the totals is found", () => {
  const r = run(mixed());
  assert.deepEqual(problems(r), []);
  assert.ok(codes(r).includes("mixed_tax_inferred"));
  assert.equal(r.summary.tax_allocation.method, "inferred");
  const a = validateTaxAllocation(norm(mixed()).extracted, norm(mixed()).items, 100);
  assert.deepEqual(a.assignment, ["IGST", "CGST_SGST"]);
});

test("mixed tax: the old tax_type_conflict warning is gone from the normal check path", () => {
  const n = norm(mixed());
  const flags = runChecks(n.extracted, n.items, { lowConfidence: 0.8, tolerancePaise: 100 });
  assert.ok(!flags.some((x) => x.code === "tax_type_conflict"));
  assert.ok(!flags.some((x) => x.severity === "error" || x.severity === "warning"));
});

test("mixed tax: line IGST / CGST / SGST that do not add up to the invoice totals are flagged", () => {
  const labelled = [goods({ applied_tax_type: f("IGST") }), install({ applied_tax_type: f("CGST_SGST") })];
  assert.ok(codes(run(mixed({ igst: f(1700), grand_total: f(14060) }, labelled))).includes("tax_allocation_mismatch"));
  assert.ok(codes(run(mixed({ igst: f(1700), grand_total: f(14060) }))).includes("mixed_tax_unreconciled"));
});

// ---- TCS (Sec 206C), TDS, pre-tax charges, round-off ------------------------------------------------------------------

const plain = (over = {}) => model({ taxable_value: f(100000), cgst: f(9000), sgst: f(9000), grand_total: f(118000), line_items: [item({ quantity: f(1), unit_price: f(100000), taxable_value: f(100000), tax_amount: f(18000), line_total: f(118000) })], ...over });

test("TCS u/s 206C is added in the grand total", () => {
  assert.deepEqual(problems(run(plain({ tcs_amount: f(1180), grand_total: f(119180) }))), []);
  const missed = run(plain({ grand_total: f(119180) })); // TCS printed in the total but not read
  assert.ok(codes(missed).includes("arithmetic_total_mismatch"));
});

test("TDS is subtracted from the grand total", () => {
  assert.deepEqual(problems(run(plain({ tds_amount: f(1000), grand_total: f(117000) }))), []);
});

test("TCS together with a printed negative round-off", () => {
  const r = run(plain({ tcs_amount: f(1180.4), round_off_amount: f(-0.4), grand_total: f(119180) }));
  assert.deepEqual(problems(r), []);
  assert.equal(r.patch.round_off_amount, undefined); // the printed round-off already explains it
});

test("pre-tax charges are accepted as a line item, or added only to the taxable base", () => {
  const freight = item({ description: f("Freight"), hsn_sac: f("9965"), quantity: f(1), unit_price: f(100), taxable_value: f(100), tax_amount: f(18), line_total: f(118) });
  const goods1000 = item({ quantity: f(1), unit_price: f(1000), taxable_value: f(1000), tax_amount: f(180), line_total: f(1180) });
  // 1. freight is a row of the item table
  assert.deepEqual(problems(run(model({ taxable_value: f(1100), cgst: f(99), sgst: f(99), grand_total: f(1298), line_items: [goods1000, freight] }))), []);
  // 2. freight is not a row: it is added to the taxable base and printed as pre-tax charges
  assert.deepEqual(problems(run(model({ taxable_value: f(1100), pre_tax_charges: f(100), cgst: f(99), sgst: f(99), grand_total: f(1298), line_items: [goods1000] }))), []);
  // 3. header taxable value excludes the charges
  assert.deepEqual(problems(run(model({ taxable_value: f(1000), pre_tax_charges: f(100), cgst: f(99), sgst: f(99), grand_total: f(1298), line_items: [goods1000] }))), []);
});

test("round-off: a difference of up to INR 2.00 is absorbed into round_off_amount and the total PASSES", () => {
  const tot = (grand) => validateInvoiceTotals(norm(model({ grand_total: f(grand) })).extracted, norm(model()).items, OPTS);
  const small = tot(1180.4); // 0.40 over
  assert.equal(small.passed, true);
  assert.equal(small.roundOffApplied, 0.4);
  assert.deepEqual(small.flags, []); // ordinary rounding is silent
  const under = tot(1179.6); // negative adjustment
  assert.equal(under.passed, true);
  assert.equal(under.roundOffApplied, -0.4);
  const edge = tot(1181.5); // 1.50: absorbed, with an info note
  assert.equal(edge.passed, true);
  assert.equal(edge.roundOffApplied, 1.5);
  assert.deepEqual(edge.flags.map((x) => x.code), ["round_off_absorbed"]);
  const two = tot(1182);
  assert.equal(two.passed, true);
  assert.equal(two.roundOffApplied, 2);
  const bad = tot(1182.5); // 2.50: a real mismatch, nothing absorbed
  assert.equal(bad.passed, false);
  assert.equal(bad.roundOffApplied, null);
  assert.deepEqual(bad.flags.map((x) => x.code), ["arithmetic_total_mismatch"]);
});

test("round-off patch is returned by validateInvoice; extracted values are never rewritten", () => {
  const n = norm(model({ grand_total: f(1180.4) }));
  const r = validateInvoice(n, OPTS);
  assert.deepEqual(r.patch, { round_off_amount: 0.4 });
  assert.equal(n.extracted.total_amount, 1180.4);
  assert.equal(r.summary.round_off_applied, 0.4);
  assert.equal(r.summary.calculated_total, 1180);
});

// ---- Multi-slab, credit notes, negative lines ----------------------------------------------------------------------------

test("multi-slab invoice: 0%, 5%, 12%, 18% and 28% on one invoice add up and are summarised per slab", () => {
  const line = (rate, tax) => item({ quantity: f(1), unit_price: f(1000), taxable_value: f(1000), gst_rate: f(rate), tax_amount: f(tax), line_total: f(1000 + tax) });
  const lines = [line(0, 0), line(5, 50), line(12, 120), line(18, 180), line(28, 280)];
  const r = run(model({ taxable_value: f(5000), cgst: f(315), sgst: f(315), grand_total: f(5630), line_items: lines }));
  assert.deepEqual(problems(r), []);
  assert.deepEqual(r.summary.slabs.map((s) => s.rate), [0, 5, 12, 18, 28]);
  assert.equal(r.summary.slabs.reduce((a, s) => a + s.tax, 0), 630);
  assert.equal(r.summary.verification.level, "verified");
  // a wrong tax on just one slab is caught
  const bad = run(model({ taxable_value: f(5000), cgst: f(315), sgst: f(315), grand_total: f(5630), line_items: [line(0, 0), line(5, 50), line(12, 120), line(18, 190), line(28, 280)] }));
  assert.ok(codes(bad).includes("arithmetic_total_mismatch") || bad.summary.verification.level === "unverified");
  assert.equal(bad.summary.verification.level, "unverified");
});

test("credit note: negative amounts are accepted without any 'negative value' warning", () => {
  const ret = item({ quantity: f(1), unit_price: f(1000), taxable_value: f(-1000), tax_amount: f(-180), line_total: f(-1180) });
  const m = model({ document_type: "credit_note", taxable_value: f(-1000), cgst: f(-90), sgst: f(-90), grand_total: f(-1180), line_items: [ret] });
  const n = norm(m);
  assert.ok(!n.extracted.review_flags.some((x) => x.code === "negative_amount"));
  assert.deepEqual(problems(validateInvoice(n, OPTS)), []);
});

test("returns and trade-volume rebates as negative lines on a normal tax invoice", () => {
  const sale = item({ quantity: f(2), unit_price: f(1000), taxable_value: f(2000), tax_amount: f(360), line_total: f(2360) });
  const rebate = item({ description: f("Volume rebate"), quantity: f(1), unit_price: f(500), taxable_value: f(-500), tax_amount: f(-90), line_total: f(-590) });
  const n = norm(model({ taxable_value: f(1500), cgst: f(135), sgst: f(135), grand_total: f(1770), line_items: [sale, rebate] }));
  assert.ok(!n.extracted.review_flags.some((x) => x.code === "negative_amount"));
  // A believable negative line (signs agree, items still add up to the invoice) raises NO per-line flag at all.
  assert.ok(!n.extracted.review_flags.some((x) => x.code === "negative_line_item"));
  const v = validateInvoice(n, OPTS);
  assert.deepEqual(v.flags, []);
  assert.deepEqual(v.summary.negative_lines, { positions: [2], status: "confirmed" });
  assert.deepEqual(problems(v), []);
  assert.deepEqual(slabSummary(n.items).map((s) => [s.rate, s.taxable]), [[18, 1500]]);
});

// ---- IRN / e-way bill metadata -------------------------------------------------------------------------------------------

test("IRN, acknowledgement number and e-way bill number are stored as text and never touch the totals", () => {
  const meta = { irn: f("a".repeat(64)), ack_no: f("112010012345678"), eway_bill_no: f("1234 5678 9012") };
  const n = norm(model(meta));
  assert.equal(n.extracted.irn, "a".repeat(64));
  assert.equal(n.extracted.ack_no, "112010012345678");
  assert.equal(n.extracted.eway_bill_no, "123456789012"); // spaces stripped
  const r = validateInvoice(n, OPTS);
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.calculated_total, 1180);
});

test("malformed IRN / e-way bill number: information note only, totals still pass", () => {
  const r = run(model({ irn: f("123"), ack_no: f("12"), eway_bill_no: f("99") }));
  assert.deepEqual(codes(r), ["invalid_irn", "invalid_ack_no", "invalid_eway_bill_no"]);
  assert.ok(r.flags.every((x) => x.severity === "info"));
  assert.equal(r.summary.total_check, "passed");
});

// ---- GSTIN auto-repair ---------------------------------------------------------------------------------------------------

test("GSTIN with a misprinted check digit is NOT repaired, even when two readings agree with confidence above 95%", () => {
  const n = norm(model({ supplier_gstin: f("27AAPFU0939F1ZW", 0.97) }), { agreed: new Set(["supplier_gstin"]) });
  assert.equal(n.extracted.vendor_gstin, "27AAPFU0939F1ZW");
  assert.equal(n.extracted.gstin_auto_corrected, false);
  assert.ok(!n.extracted.review_flags.some((x) => x.code === "gstin_auto_corrected"));
  const flag = n.extracted.review_flags.find((x) => x.code === "gstin_checksum_note");
  assert.equal(flag.severity, "info");
  assert.deepEqual(flag.details.suggestions, ["27AAPFU0939F1ZV"]);
});

test("GSTIN with a wrong check digit is NOT changed when the reading is not confirmed, and the state code is never touched", () => {
  const low = norm(model({ supplier_gstin: f("27AAPFU0939F1ZW", 0.9) }), { agreed: new Set(["supplier_gstin"]) });
  assert.equal(low.extracted.vendor_gstin, "27AAPFU0939F1ZW");
  assert.equal(low.extracted.gstin_auto_corrected, false);
  assert.ok(low.extracted.review_flags.some((x) => x.code === "invalid_gstin"));
  const wrongState = norm(model({ supplier_gstin: f("28AAPFU0939F1ZV", 0.99) }), { agreed: new Set(["supplier_gstin"]) });
  // only the 15th character may change; the state code, PAN and entity number stay exactly as read
  assert.equal(wrongState.extracted.vendor_gstin.slice(0, 14), "28AAPFU0939F1Z");
});

// ---- Schema / parser -------------------------------------------------------------------------------------------------------

test("schema accepts the new optional fields and the per-line labels, and still rejects unknown keys", () => {
  const ok = validateModelOutput(model({ tcs_amount: f(10), tds_amount: f(5), pre_tax_charges: f(100), round_off_amount: f(-0.4), exchange_rate: f(1), irn: f("a".repeat(64)), ack_no: f("1"), eway_bill_no: f("2"), line_items: [item({ discount_type: f("PERCENT"), applied_tax_type: f("IGST") })] }));
  assert.equal(ok.ok, true);
  assert.equal(validateModelOutput(model({ surprise: f(1) })).ok, false);
  assert.equal(validateModelOutput(model({ tcs_amount: f("x") })).ok, false);
  assert.equal(validateModelOutput(model({ line_items: [item({ hsn_sac: undefined })] })).ok, false);
});

test("per-line labels are normalised: % / FLAT, CGST+SGST / IGST", () => {
  const lines = [item({ discount_type: f("%"), applied_tax_type: f("CGST + SGST") }), item({ discount_type: f("Amount"), applied_tax_type: f("igst") }), item({ discount_type: f("???"), applied_tax_type: f("???") })];
  const n = norm(model({ line_items: lines }));
  assert.deepEqual(n.items.map((i) => [i.discount_type, i.applied_tax_type]), [["PERCENT", "CGST_SGST"], ["FLAT", "IGST"], [null, null]]);
});

test("the engine summary is plain JSON that can be stored", () => {
  const r = run(model());
  assert.deepEqual(JSON.parse(JSON.stringify(r.summary)), r.summary);
  assert.equal(r.summary.version, 1);
});
