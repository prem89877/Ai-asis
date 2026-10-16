// One problem, one flag; honest "which cause" hints; and the bottom-line fields a reviewer can now correct.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { diagnoseTotalMismatch } from "../lib/extraction/tax-math.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { computeReviewFlags, toStoredExtracted } from "../lib/review/flags.ts";
import { gstChecks } from "../lib/review/gst.ts";
import { HEADER_COLUMNS, HEADER_FIELDS } from "../lib/review/fields.ts";
import { parseReviewInput } from "../lib/review/input.ts";
import { applyReview } from "../lib/review/apply.ts";
import { checkHeaderDraft } from "../lib/review/draft-check.ts";
import { f, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const ROPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const run = (m) => validateInvoice(norm(m), OPTS);
const codes = (flags) => flags.map((x) => x.code);
const FS = Object.fromEntries(["supplier_name", "supplier_gstin", "buyer_name", "invoice_number", "invoice_date", "taxable_value", "grand_total", "cgst", "sgst"].map((k) => [k, { state: "value", confidence: 1 }]));
const header = (over = {}) => ({
  ...Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null])),
  vendor_name: "Acme", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", invoice_number: "INV-1", invoice_date: "2026-09-15",
  place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, total_amount: 1180, ...over,
});
const item = (o = {}) => ({ description: "W", hsn_code: "8471", quantity: 2, unit: "Nos", unit_price: 500, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180, field_status: {}, ...o });

test("CGST != SGST is reported once: not by two checks, and not next to a tax head finding", () => {
  const flags = computeReviewFlags(header({ sgst_amount: 80, total_amount: 1170 }), FS, [item()], ROPTS);
  const same = flags.filter((x) => ["cgst_sgst_unequal", "tax_component_mismatch", "tax_allocation_mismatch"].includes(x.code));
  assert.equal(same.length, 1);
  // review/gst.ts has no copy of the rule any more
  assert.ok(!codes(gstChecks(header({ sgst_amount: 80 }), [item()], OPTS)).includes("cgst_sgst_unequal"));
  // no line evidence at all: the generic flag is still raised, exactly once
  const noLines = computeReviewFlags(header({ sgst_amount: 80, total_amount: 1170 }), FS, [], ROPTS);
  assert.equal(codes(noLines).filter((c) => c === "cgst_sgst_unequal").length, 1);
});

test("one line, one verdict: a half-rate line is accepted everywhere, a wrong line is flagged once with its position", () => {
  const half = computeReviewFlags(header(), FS, [item({ gst_amount: 90 })], ROPTS);
  assert.ok(!codes(half).includes("item_tax_rate_mismatch"));
  assert.ok(!codes(half).includes("line_tax_rate_mismatch"));
  const bad = computeReviewFlags(header(), FS, [item({ gst_amount: 108 })], ROPTS);
  const hits = bad.filter((x) => x.code === "item_tax_rate_mismatch");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemPosition, 1);
  assert.ok(!codes(bad).includes("line_tax_rate_mismatch"));
  // the extraction-time engine gives the same verdict for the same line
  assert.ok(run(model({ line_items: [{ ...model().line_items[0], tax_amount: f(108) }] })).flags.some((x) => x.code === "item_tax_rate_mismatch" && x.itemPosition === 1));
});

test("diagnosis: equal amounts are listed together, never one arbitrary 'most likely'", () => {
  const parts = { actual: 0, base: 100000, cgst: 9000, sgst: 9000, utgst: 0, igst: 0, cess: 0, tcs: 0, tds: 0, discount: null, charges: null, expectedTotal: 118000, lineImpliedTax: null };
  const d = diagnoseTotalMismatch({ ...parts, actual: 109000 });
  const got = d.map((x) => x.code).sort();
  assert.deepEqual(got, ["total_without_cgst", "total_without_sgst"]); // no duplicate "neither SGST nor UTGST" when there is no UTGST
  for (const x of d) assert.ok(x.ambiguousWith && x.ambiguousWith.length === 1);
  // a unique cause stays unique
  const tcs = diagnoseTotalMismatch({ ...parts, tcs: 1000, expectedTotal: 119000, actual: 118000 });
  assert.equal(tcs[0].code, "total_without_tcs");
  assert.equal(tcs[0].ambiguousWith, undefined);
});

test("diagnosis wording: ambiguous gap says so, unique gap says 'Most likely'", () => {
  const amb = run(model({ grand_total: f(1090) })).flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(amb);
  assert.ok(!amb.message.includes("Most likely"));
  assert.ok(amb.message.includes("cannot tell which"));
  const uniq = run(model({ cess: f(50), grand_total: f(1180) })).flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(uniq.message.includes("Most likely"));
});

test("utgst_not_read fires when no UTGST figure exists (missing or 0), not when UTGST is present", () => {
  const parts = { actual: 0, base: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0, tcs: 0, tds: 0, discount: null, charges: null, expectedTotal: 118000, lineImpliedTax: null };
  const over = { ...parts, actual: 127000 }; // higher by exactly the SGST amount
  assert.ok(diagnoseTotalMismatch(over).some((x) => x.code === "utgst_not_read")); // utgst field left out entirely (optional)
  assert.ok(diagnoseTotalMismatch({ ...over, utgst: 0 }).some((x) => x.code === "utgst_not_read"));
  assert.ok(!diagnoseTotalMismatch({ ...over, utgst: 4000 }).some((x) => x.code === "utgst_not_read"));
});

test("a reviewer can now correct exchange rate, TCS, TDS, round-off, pre-tax charges and net payable", () => {
  for (const c of ["exchange_rate", "tcs_amount", "tds_amount", "round_off_amount", "pre_tax_charges", "net_payable_amount"]) assert.ok(HEADER_FIELDS.some((d) => d.column === c), c);
  const ok = parseReviewInput({ expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save", header: { exchange_rate: "83.123456", tcs_amount: "12.5", tds_amount: "0", round_off_amount: "-0.4", pre_tax_charges: "100", net_payable_amount: "1,000" } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.header, { exchange_rate: 83.123456, tcs_amount: 12.5, tds_amount: 0, round_off_amount: -0.4, pre_tax_charges: 100, net_payable_amount: 1000 });
  const blank = parseReviewInput({ expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save", header: { exchange_rate: "" } });
  assert.equal(blank.value.header.exchange_rate, null); // no rate printed stays NULL
  for (const bad of ["0", "-1", "abc", "83.1234567"]) assert.equal(parseReviewInput({ expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save", header: { exchange_rate: bad } }).ok, false, bad);
  assert.equal(parseReviewInput({ expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save", header: { tcs_amount: "x" } }).ok, false);
});

test("a corrected TCS is saved as a human value and used by the re-check", () => {
  const current = { header: header({ tcs_amount: 5 }), field_status: { tcs_amount: { state: "value", confidence: 0.4, source: "model" } }, corrected_fields: {}, items: [] };
  const applied = applyReview(current, { header: { tcs_amount: 10 } }, "u1", "2026-10-16T00:00:00Z");
  assert.equal(applied.header.tcs_amount, 10);
  assert.equal(applied.fieldStatus.tcs_amount.source, "human");
  assert.equal(applied.corrected.tcs_amount.original, 5);
  // header value wins over the saved extras; an older caller that sends no such column still gets the saved value
  assert.equal(toStoredExtracted(applied.header, applied.fieldStatus, { tcs_amount: 5 }).tcs_amount, 10);
  const { tcs_amount: _omit, ...withoutCol } = applied.header;
  assert.equal(toStoredExtracted(withoutCol, applied.fieldStatus, { tcs_amount: 5 }).tcs_amount, 5);
  // TCS of 20 is part of the total: with it typed, the total 1200 ties and there is no total mismatch
  const flags = computeReviewFlags(header({ tcs_amount: 20, total_amount: 1200 }), FS, [item()], ROPTS);
  assert.ok(!codes(flags).includes("arithmetic_total_mismatch"));
  const without = computeReviewFlags(header({ total_amount: 1200 }), FS, [item()], ROPTS);
  assert.ok(codes(without).includes("arithmetic_total_mismatch"));
});

test("round-off may be negative without a 'negative amount' warning; the draft check knows the new fields", () => {
  const flags = computeReviewFlags(header({ round_off_amount: -0.4, total_amount: 1179.6 }), FS, [item()], ROPTS);
  assert.ok(!flags.some((x) => x.code === "negative_amount" && x.field === "round_off_amount"));
  const base = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, ""]));
  const draft = { ...base, taxable_amount: "1000", cgst_amount: "90", sgst_amount: "90", total_amount: "1200", tcs_amount: "20", currency: "INR" };
  const issues = checkHeaderDraft(draft, base);
  assert.equal(issues.total_amount, undefined); // 1000 + 180 + TCS 20 = 1200
  assert.ok(checkHeaderDraft({ ...base, exchange_rate: "0" }, base).exchange_rate?.some((x) => x.severity === "error"));
  assert.equal(checkHeaderDraft({ ...base, round_off_amount: "-0.40" }, base).round_off_amount, undefined);
});
