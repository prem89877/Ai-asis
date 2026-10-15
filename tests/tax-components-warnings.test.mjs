// Component-specific tax validation and TCS / TDS / discount treatment.
// The figures below are TEST DATA taken from the two supplied invoices. Production code never contains them.
//   Invoice A "GST Tax Invoice CGST SGST UTGST IGST": taxable 350,000 | CGST 18,000 | SGST 9,000 | UTGST 9,000 | IGST 27,000 | GST 63,000 | total 413,000
//   Invoice B "Domestic Tax Invoice with CGST SGST and Cess": taxable 400,000 | CGST 51,500 | SGST 51,500 | cess 44,700 | subtotal 547,700
//             commercial discount 2,700 | net payable 545,000 | TCS / TDS not applied
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { reconcileTaxComponents } from "../lib/extraction/tax-reconcile.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { f, missing, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-15") });
const run = (m) => validateInvoice(norm(m), OPTS);
const problems = (r) => r.flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code);

const line = (taxable, tax, type, rate = 18, extra = {}) => item({
  description: f("Line"), quantity: f(1), unit_price: f(taxable), taxable_value: f(taxable), gst_rate: f(rate), tax_amount: f(tax), line_total: f(taxable + tax),
  ...(type ? { applied_tax_type: f(type) } : {}), ...extra,
});
const A = (over = {}, types = ["IGST", "CGST+SGST", "CGST+UTGST"]) => model({
  taxable_value: f(350000), cgst: f(18000), sgst: f(9000), utgst_amount: f(9000), igst: f(27000), cess: missing(), grand_total: f(413000),
  tcs_amount: f(0), tds_amount: f(0),
  line_items: [line(150000, 27000, types[0]), line(100000, 18000, types[1]), line(100000, 18000, types[2])],
  ...over,
});
const find = (r, code) => r.flags.find((x) => x.code === code);
const comp = (flag, field) => flag.details.components.find((c) => c.field === field);

// ---- Invoice A ------------------------------------------------------------------------------------------------------------
test("invoice A: every component reconciles, no TCS / TDS, no false grand total mismatch", () => {
  const r = run(A());
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.verification.level, "verified");
  const c = r.summary.tax_components;
  assert.deepEqual(c.invoice, { cgst: 18000, sgst: 9000, utgst: 9000, igst: 27000, cess: 0, total_gst: 63000 });
  assert.deepEqual(c.lines, { cgst: 18000, sgst: 9000, utgst: 9000, igst: 27000 });
  assert.deepEqual(c.failed, []);
  assert.deepEqual([r.summary.adjustments.tcs, r.summary.adjustments.tds, r.summary.adjustments.tcs_tds_applied], [0, 0, false]);
  assert.equal(r.summary.expected_grand_total, 413000); // no TCS / TDS adjustment is introduced
});

test("invoice A: CGST 18,000 is compared with SGST + UTGST, never with SGST 9,000 alone", () => {
  const rec = reconcileTaxComponents(norm(A()).extracted, norm(A()).items, 100);
  assert.deepEqual(rec.heads, []);
  assert.equal(rec.totals.fromComponents, 63000);
  assert.equal(rec.totals.fromLines, 63000);
});

test("invoice A without any tcs / tds fields behaves the same (not applied = no adjustment)", () => {
  const m = A();
  delete m.tcs_amount; delete m.tds_amount;
  const r = run(m);
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.adjustments.tcs_tds_applied, false);
});

// ---- A correct grand total must not let a wrong breakdown pass ------------------------------------------------------------
test("UTGST merged into SGST: grand total still matches, the specific discrepancy is reported and verification fails", () => {
  const r = run(A({ sgst: f(18000), utgst_amount: f(0) }));
  assert.equal(r.summary.total_check, "passed"); // 350,000 + 18,000 + 18,000 + 27,000 = 413,000
  const flag = find(r, "tax_allocation_mismatch");
  assert.ok(flag, "breakdown error must be flagged although the total matches");
  assert.equal(flag.severity, "warning");
  const sgst = comp(flag, "sgst"), utgst = comp(flag, "utgst_amount");
  assert.deepEqual([sgst.expected, sgst.observed, sgst.diagnosis], [9000, 18000, "utgst_merged_into_sgst"]);
  assert.deepEqual([utgst.expected, utgst.observed, utgst.diagnosis], [9000, 0, "utgst_merged_into_sgst"]);
  assert.match(utgst.reason, /merged into SGST/);
  assert.match(flag.message, /UTGST: expected INR 9000\.00, found INR 0\.00/);
  assert.notEqual(r.summary.verification.level, "verified");
  assert.ok(r.summary.tax_components.failed.includes("utgst_amount"));
});

test("UTGST missing: the UTGST head is named with expected and observed value and the reason", () => {
  const m = A({ grand_total: f(404000) });
  delete m.utgst_amount;
  const r = run(m);
  const flag = find(r, "tax_allocation_mismatch");
  const utgst = comp(flag, "utgst_amount");
  assert.deepEqual([utgst.expected, utgst.observed, utgst.diagnosis], [9000, 0, "utgst_missing"]);
  assert.match(utgst.reason, /no UTGST amount was found/);
  assert.equal(flag.field, "utgst_amount");
});

test("CGST, SGST and UTGST swapped but the total unchanged: flagged per field", () => {
  const r = run(A({ cgst: f(9000), sgst: f(18000), utgst_amount: f(9000) }));
  assert.equal(r.summary.total_check, "passed");
  const flag = find(r, "tax_allocation_mismatch");
  assert.ok(flag);
  assert.deepEqual([comp(flag, "cgst").expected, comp(flag, "cgst").observed], [18000, 9000]);
  assert.deepEqual([comp(flag, "sgst").expected, comp(flag, "sgst").observed], [9000, 18000]);
  assert.equal(comp(flag, "igst"), undefined, "IGST is correct and must not be reported");
});

test("IGST moved into CGST/SGST with the total unchanged is flagged", () => {
  const r = run(A({ igst: f(0), cgst: f(18000 + 13500), sgst: f(9000 + 13500), utgst_amount: f(9000) }));
  assert.equal(r.summary.total_check, "passed");
  const flag = find(r, "tax_allocation_mismatch");
  assert.ok(flag);
  assert.deepEqual([comp(flag, "igst").expected, comp(flag, "igst").observed], [27000, 0]);
});

test("lines without a tax label: a wrong split of the same tax is still caught (supply-type basis)", () => {
  // 1,000 taxable, 180 tax on the lines. Printed CGST 135 + SGST 45 = 180, so the total matches, but CGST and SGST must be equal halves.
  const r = run(model({ cgst: f(135), sgst: f(45), grand_total: f(1180) }));
  assert.equal(r.summary.total_check, "passed");
  const flag = find(r, "tax_component_mismatch");
  assert.ok(flag);
  assert.deepEqual([comp(flag, "cgst").expected, comp(flag, "cgst").observed], [90, 135]);
  assert.equal(comp(flag, "sgst").expected, 90);
  assert.notEqual(r.summary.verification.level, "verified");
});

test("cess is checked against the cess the item totals imply", () => {
  const withCess = (cess) => model({
    taxable_value: f(1000), cgst: f(90), sgst: f(90), cess: f(cess), grand_total: f(1180 + cess),
    line_items: [item({ line_total: f(1180 + 50) })], // the line total includes a cess of 50
  });
  assert.deepEqual(problems(run(withCess(50))), []);
  const r = run(withCess(30));
  const flag = r.flags.filter((x) => x.code === "tax_component_mismatch").find((x) => x.field === "cess");
  assert.ok(flag);
  assert.deepEqual([comp(flag, "cess").expected, comp(flag, "cess").observed], [50, 30]);
});

test("the grand total warning states the field, expected value, observed value and reason", () => {
  const r = run(A({ grand_total: f(414000) }));
  const flag = find(r, "arithmetic_total_mismatch");
  assert.ok(flag);
  assert.equal(flag.details.field, "grand_total");
  assert.equal(flag.details.expected, 413000);
  assert.equal(flag.details.observed, 414000);
  assert.equal(flag.details.difference, 1000);
  assert.ok(flag.details.reason.length > 10);
  assert.deepEqual(flag.details.components.cgst, 18000);
  assert.match(flag.message, /Expected INR 413000\.00, found INR 414000\.00/);
});

test("genuine warnings are never suppressed: a wrong total AND a wrong head are both reported", () => {
  const r = run(A({ igst: f(26000), grand_total: f(413000) }));
  const codes = problems(r);
  assert.ok(codes.includes("arithmetic_total_mismatch"));
  assert.ok(codes.includes("tax_allocation_mismatch"));
});

test("pre-tax charges that are not item rows do not raise a false component warning", () => {
  const goods = item({ quantity: f(1), unit_price: f(1000), taxable_value: f(1000), tax_amount: f(180), line_total: f(1180) });
  assert.deepEqual(problems(run(model({ taxable_value: f(1100), pre_tax_charges: f(100), cgst: f(99), sgst: f(99), grand_total: f(1298), line_items: [goods] }))), []);
});

// ---- Invoice B: discount is not TCS / TDS ----------------------------------------------------------------------------------
const B = (over = {}) => model({
  taxable_value: f(400000), cgst: f(51500), sgst: f(51500), igst: missing(), cess: f(44700),
  grand_total: f(547700), discount_total: f(2700), net_payable_amount: f(545000), tcs_amount: f(0), tds_amount: f(0),
  line_items: [line(400000, 103000, "CGST+SGST", 25.75, { line_total: f(547700) })],
  ...over,
});

test("invoice B: subtotal 547,700, commercial discount 2,700, net payable 545,000 reconcile with no TDS and no warning", () => {
  const r = run(B());
  assert.deepEqual(r.flags, [], "a discount must not be reported as a missing TDS");
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.adjustments.tcs_tds_applied, false);
  assert.equal(r.summary.adjustments.discount, 2700);
  assert.equal(r.summary.adjustments.discount_treatment, "not_in_total");
  assert.equal(r.summary.adjustments.net_payable_printed, 545000);
});

test("invoice B read the other way round: printed total is the 545,000 net figure", () => {
  const r = run(B({ grand_total: f(545000) }));
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.adjustments.discount_treatment, "deducted_after_tax");
  assert.equal(r.summary.adjustments.tds, 0);
});

test("invoice B without any TCS / TDS fields: same result, nothing is deducted or added", () => {
  const m = B();
  delete m.tcs_amount; delete m.tds_amount;
  const r = run(m);
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.expected_net_payable, null); // no TDS, so no TDS-based net figure
});

test("a net payable that the discount does NOT explain is still reported", () => {
  const r = run(B({ net_payable_amount: f(540000) }));
  assert.deepEqual(r.flags.map((x) => x.code), ["net_payable_tds_not_found"]);
});

test("a TDS figure identical to the discount is flagged as a probable mix-up, both values kept", () => {
  const r = run(B({ tds_amount: f(2700) }));
  const flag = find(r, "tds_matches_discount");
  assert.ok(flag);
  assert.equal(flag.severity, "warning");
  assert.equal(flag.field, "tds_amount");
  assert.equal(norm(B({ tds_amount: f(2700) })).extracted.tds_amount, 2700, "nothing is changed silently");
});

test("a genuine TDS that differs from the discount is not confused with it", () => {
  const r = run(B({ grand_total: f(547700), tds_amount: f(547), net_payable_amount: f(547153 - 2700 + 0) }));
  assert.ok(!r.flags.some((x) => x.code === "tds_matches_discount"));
});

// ---- Tally: a commercial discount printed after the taxes is booked, not skipped ------------------------------------------------
import { buildVouchers, voucherBalance, DEFAULT_TALLY_CONFIG } from "../lib/tally/build.ts";

const tallyInv = (over = {}) => ({
  id: "i1", original_filename: "b.pdf", status: "verified", created_at: "2026-10-01T00:00:00Z", vendor_name: "Acme", vendor_gstin: "27AAPFU0939F1ZV",
  buyer_name: "Beta", buyer_gstin: null, invoice_number: "B-1", invoice_date: "2026-10-01", place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice",
  taxable_amount: 400000, discount_amount: 2700, cgst_amount: 51500, sgst_amount: 51500, utgst_amount: null, igst_amount: null, cess_amount: 44700, tax_total: 147700,
  total_amount: 545000, confidence: 0.99, review_flags: [], verified_at: "2026-10-02T00:00:00Z", ...over,
});

test("tally: printed total 545,000 = subtotal 547,700 - commercial discount 2,700 balances with a discount ledger entry", () => {
  const { vouchers, skipped } = buildVouchers([tallyInv()], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0);
  assert.equal(voucherBalance(vouchers[0]), 0);
  const d = vouchers[0].entries.find((x) => x.ledger === DEFAULT_TALLY_CONFIG.discountLedger);
  assert.deepEqual([d.side, d.paise], ["Cr", 270000]);
});

test("tally: printed total equal to the subtotal needs no discount entry", () => {
  const { vouchers } = buildVouchers([tallyInv({ total_amount: 547700 })], DEFAULT_TALLY_CONFIG);
  assert.equal(voucherBalance(vouchers[0]), 0);
  assert.ok(!vouchers[0].entries.some((x) => x.ledger === DEFAULT_TALLY_CONFIG.discountLedger));
});

test("tally: a gap that is not the discount is still skipped with the usual message", () => {
  const { vouchers, skipped } = buildVouchers([tallyInv({ total_amount: 540000 })], DEFAULT_TALLY_CONFIG);
  assert.equal(vouchers.length, 0);
  assert.match(skipped[0].reason, /does not add up|invoice total is/);
});
