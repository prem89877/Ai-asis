// UTGST is its own tax head. Invoice evidence: "GST Tax Invoice CGST SGST UTGST IGST.pdf"
//   taxable 350,000 | IGST 27,000 | CGST 18,000 | SGST 9,000 | UTGST 9,000 | total GST 63,000 | grand total 413,000
//   lines: inter-state 150,000 @18% IGST | intra-state 100,000 @18% CGST+SGST | Union Territory 100,000 @18% CGST+UTGST
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice, validateInvoiceTotals, validateTaxAllocation } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";
import { gstChecks } from "../lib/review/gst.ts";
import { taxHeadsPaise, totalGstPaise, totalTaxPaise, stateTaxPaise } from "../lib/extraction/tax-components.ts";
import { f, missing, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-15") });
const run = (m) => validateInvoice(norm(m), OPTS);
const problems = (r) => r.flags.filter((x) => x.severity === "error" || x.severity === "warning").map((x) => x.code);

const line = (taxable, tax, type) => item({
  description: f("Line"), quantity: f(1), unit_price: f(taxable), taxable_value: f(taxable), gst_rate: f(18), tax_amount: f(tax), line_total: f(taxable + tax),
  ...(type ? { applied_tax_type: f(type) } : {}),
});
const invoice = (over = {}, types = ["IGST", "CGST+SGST", "CGST+UTGST"]) => model({
  taxable_value: f(350000), cgst: f(18000), sgst: f(9000), utgst_amount: f(9000), igst: f(27000), cess: missing(), grand_total: f(413000),
  line_items: [line(150000, 27000, types[0]), line(100000, 18000, types[1]), line(100000, 18000, types[2])],
  ...over,
});

test("the exact invoice: every head is stored on its own and total GST is 63,000", () => {
  const { extracted: e, items } = norm(invoice());
  assert.deepEqual([e.cgst_amount, e.sgst_amount, e.utgst_amount, e.igst_amount, e.total_amount], [18000, 9000, 9000, 27000, 413000]);
  assert.deepEqual(items.map((i) => i.applied_tax_type), ["IGST", "CGST_SGST", "CGST_UTGST"]);
  const h = taxHeadsPaise(e);
  assert.equal(totalGstPaise(h), 6300000);
  assert.equal(stateTaxPaise(h), 1800000);
  assert.equal(totalTaxPaise(h), 6300000); // cess 0
});

test("the exact invoice passes every layer with no warning: no SGST/UTGST double count, CGST is compared with SGST + UTGST", () => {
  const r = run(invoice());
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.expected_grand_total, 413000);
  assert.equal(r.summary.verification.level, "verified");
  assert.equal(r.summary.verification.methods.find((m) => m.id === "printed_invoice_tax").value, 63000);
});

test("the grand total is never changed to make things fit", () => {
  assert.equal(norm(invoice()).extracted.total_amount, 413000);
  const bad = norm(invoice({ grand_total: f(413500) })).extracted; // a wrong printed total stays wrong and is flagged
  assert.equal(bad.total_amount, 413500);
  assert.ok(problems(run(invoice({ grand_total: f(413500) }))).includes("arithmetic_total_mismatch"));
});

test("lines without a tax label still reconcile (split inferred, state tax = SGST + UTGST)", () => {
  const r = run(invoice({}, [undefined, undefined, undefined]));
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
});

test("legacy reading without UTGST: the 9,000 gap is reported and the likely cause names a UTGST that was not read", () => {
  const m = invoice({ utgst_amount: undefined }); // old extraction: only SGST/UTGST = 9,000 was kept
  delete m.utgst_amount;
  const r = run(m);
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(flag, "a 9,000 gap must still be reported");
  assert.equal(flag.details.expected, 404000);
  assert.ok(flag.details.likelyCauses.some((c) => c.code === "utgst_not_read"));
});

test("legacy row that kept the whole state tax in sgst_amount (UTGST null) is not double counted", () => {
  const m = invoice({ sgst: f(18000) });
  delete m.utgst_amount;
  const r = run(m);
  assert.equal(r.summary.total_check, "passed");
  assert.deepEqual(problems(r), []);
});

test("a wrong UTGST is reported with the specific head and amounts", () => {
  const r = run(invoice({ utgst_amount: f(8000), grand_total: f(412000) }));
  const flag = r.flags.find((x) => x.code === "tax_allocation_mismatch");
  assert.ok(flag);
  assert.ok(flag.details.mismatchedHeads.includes("UTGST"));
  const d = flag.details.discrepancies.find((x) => x.head === "UTGST");
  assert.deepEqual([d.invoice, d.lines, d.difference], [8000, 9000, -1000]);
  assert.ok(r.flags.some((x) => x.code === "cgst_sgst_unequal")); // CGST 18,000 vs SGST + UTGST 17,000
});

test("a Union Territory only invoice (CGST + UTGST) is valid and needs no SGST", () => {
  const r = run(model({ taxable_value: f(1000), cgst: f(90), sgst: missing(), utgst_amount: f(90), grand_total: f(1180), line_items: [item({ applied_tax_type: f("CGST_UTGST") })] }));
  assert.deepEqual(problems(r), []);
  assert.equal(r.summary.total_check, "passed");
});

test("review-screen checks use the same rule (CGST vs SGST + UTGST)", () => {
  const { extracted: e, items } = norm(invoice());
  const flags = gstChecks(e, items, OPTS);
  assert.ok(!flags.some((x) => x.code === "cgst_sgst_unequal"));
  assert.ok(!flags.some((x) => x.code === "invoice_tax_rate_mismatch"));
});

test("cess and TCS stay outside total GST but inside the grand total", () => {
  const r = run(invoice({ cess: f(1000), tcs_amount: f(500), grand_total: f(414500) }));
  assert.equal(r.summary.total_check, "passed");
  assert.equal(totalGstPaise(taxHeadsPaise(norm(invoice({ cess: f(1000) })).extracted)), 6300000);
});

test("utgst_amount is optional in the model output schema", () => {
  assert.equal(validateModelOutput(invoice()).ok, true);
  const m = invoice(); delete m.utgst_amount;
  assert.equal(validateModelOutput(m).ok, true);
});
