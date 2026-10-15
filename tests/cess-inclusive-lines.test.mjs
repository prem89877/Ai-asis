// Regression: "CGST expected 73,850, found 51,500" on the domestic invoice with CGST, SGST and GST compensation cess.
// Cause: the tax printed on each item line was GST + cess (36.925 % of the taxable value) and was read as CGST + SGST, so every
// head came out too high by half the cess. The figures below are TEST DATA from that invoice; production code never contains them.
//   taxable 400,000 | CGST 51,500 | SGST 51,500 | cess 44,700 | subtotal 547,700 | discount 2,700 | net payable 545,000 | no TCS / TDS
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { reconcileTaxComponents } from "../lib/extraction/tax-reconcile.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { f, missing, item, model } from "./helpers.mjs";

const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-15") });
const run = (m) => validateInvoice(norm(m), { tolerancePaise: 100 });
const bad = (r) => r.flags.filter((x) => x.severity !== "info").map((x) => x.code);

// Three lines, each carries GST + cess in its tax figure. `ratePct` = tax printed per line / taxable x 100, `type` = line label.
const lines = (ratePct, rate, type = "CGST+SGST", split = [200000, 120000, 80000]) => split.map((t) => item({
  description: f("Line"), quantity: f(1), unit_price: f(t), taxable_value: f(t), gst_rate: f(rate), tax_amount: f(Math.round(t * ratePct) / 100),
  line_total: f(Math.round(t * (100 + ratePct)) / 100), applied_tax_type: f(type),
}));
const inv = (over = {}) => model({
  taxable_value: f(400000), cgst: f(51500), sgst: f(51500), igst: missing(), cess: f(44700), grand_total: f(547700), discount_total: f(2700),
  net_payable_amount: f(545000), tcs_amount: f(0), tds_amount: f(0), line_items: lines(36.925, 25.75), ...over,
});

test("the extracted invoice-level values are kept exactly: CGST 51,500, SGST 51,500, cess 44,700", () => {
  const e = norm(inv()).extracted;
  assert.deepEqual([e.cgst_amount, e.sgst_amount, e.cess_amount, e.taxable_amount, e.discount_amount, e.net_payable_amount], [51500, 51500, 44700, 400000, 2700, 545000]);
});

test("line tax = GST + cess: no CGST / SGST mismatch, cess taken out, the stored figures untouched", () => {
  const r = run(inv());
  assert.deepEqual(bad(r), []);
  const note = r.flags.find((x) => x.code === "line_tax_includes_cess");
  assert.ok(note, "the adjustment is visible, not silent");
  assert.equal(note.severity, "info");
  assert.equal(note.details.cess, 44700);
  assert.equal(r.summary.verification.level, "verified");
  assert.equal(r.summary.total_check, "passed");
});

test("the heads rebuilt from the lines are CGST 51,500 / SGST 51,500 (not 73,850) and cess is not part of them", () => {
  const n = norm(inv());
  const rec = reconcileTaxComponents(n.extracted, n.items, 100);
  assert.deepEqual(rec.heads, []);
  assert.equal(rec.cess, null);
  assert.deepEqual([rec.lineSplit.cgst, rec.lineSplit.sgst, rec.lineSplit.utgst, rec.lineSplit.igst], [51500, 51500, 0, 0]);
  assert.equal(rec.totals.fromLines, 103000);
  assert.equal(rec.lineTaxIncludesCess, 44700);
});

test("GST rate printed as the GST-only rate (25.75 %) with a cess-inclusive tax column is accepted too", () => {
  assert.deepEqual(bad(run(inv({ line_items: lines(36.925, 25.75) }))), []);
});

test("an invoice whose line tax is GST only (cess shown separately) behaves as before and raises no cess note", () => {
  const r = run(inv({ line_items: lines(25.75, 25.75) }));
  assert.deepEqual(r.flags, []);
});

test("different line amounts and any number of lines work: nothing depends on this invoice's figures", () => {
  assert.deepEqual(bad(run(inv({ line_items: lines(36.925, 25.75, "CGST+SGST", [400000]) }))), []);
  assert.deepEqual(bad(run(inv({ line_items: lines(36.925, 25.75, "CGST+SGST", [100000, 100000, 100000, 100000]) }))), []);
});

test("CGST + UTGST lines with cess in the line tax: CGST 51,500 = UTGST 51,500", () => {
  const m = inv({ sgst: missing(), utgst_amount: f(51500), line_items: lines(36.925, 25.75, "CGST+UTGST") });
  const r = run(m);
  assert.deepEqual(bad(r), []);
  assert.deepEqual([r.summary.tax_components.lines.cgst, r.summary.tax_components.lines.utgst, r.summary.tax_components.lines.sgst], [51500, 51500, 0]);
});

// ---- Genuine errors stay visible --------------------------------------------------------------------------------------------
test("a wrong CGST / SGST split with the same total is still reported", () => {
  const r = run(inv({ cgst: f(60000), sgst: f(43000) }));
  assert.ok(bad(r).length > 0);
  assert.notEqual(r.summary.verification.level, "verified");
});

test("a line tax that does not reproduce GST + cess is NOT treated as cess-inclusive", () => {
  const l = lines(36.925, 25.75);
  l[0] = item({ ...l[0], tax_amount: f(60000) }); // 73,850 -> 60,000: the lines no longer add up to GST + cess
  const r = run(inv({ line_items: l }));
  assert.ok(r.flags.some((x) => x.code === "tax_allocation_mismatch"));
  assert.ok(!r.flags.some((x) => x.code === "line_tax_includes_cess"));
});

test("no cess on the invoice: a larger line tax is a real mismatch", () => {
  const r = run(inv({ cess: missing(), grand_total: f(503000) }));
  assert.ok(r.flags.some((x) => x.code === "tax_allocation_mismatch"), "line tax 147,700 vs GST 103,000 with no cess printed");
});

test("mixed IGST + CGST/SGST lines: the cess cannot be placed on a head, so the mismatch stays visible", () => {
  const l = [...lines(36.925, 25.75, "CGST+SGST", [200000]), ...lines(36.925, 25.75, "IGST", [200000])];
  const r = run(inv({ igst: f(51500), line_items: l }));
  assert.ok(r.flags.some((x) => x.code === "tax_allocation_mismatch" || x.code === "tax_component_mismatch"));
  assert.ok(!r.flags.some((x) => x.code === "line_tax_includes_cess"));
});
