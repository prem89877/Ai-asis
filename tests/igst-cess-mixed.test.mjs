// Regression: "IGST: expected INR 212000.00, found INR 182000.00. The 3 IGST line(s) add up to INR 212000.00".
// Cause: on an invoice with IGST lines AND CGST/SGST lines, the tax printed on the IGST lines was IGST + cess, and the cess-inclusive
// rule only handled single-family invoices. The figures below are TEST DATA; production code never contains them.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { removeCessFromLineTaxes } from "../lib/extraction/tax-components.ts";
import { f, missing, item, model } from "./helpers.mjs";

const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-15") });
const run = (m) => validateInvoice(norm(m), { tolerancePaise: 100 });
const bad = (r) => r.flags.filter((x) => x.severity !== "info").map((x) => x.code);
const ln = (t, pct, type, rate) => item({
  description: f("Line"), quantity: f(1), unit_price: f(t), taxable_value: f(t), gst_rate: f(rate), tax_amount: f(Math.round(t * pct) / 100),
  line_total: f(Math.round(t * (100 + pct)) / 100), applied_tax_type: f(type),
});
// 3 IGST lines whose printed tax is IGST 18.2 % + cess 3 % = 21.2 %, plus one CGST+SGST line (18 %, no cess in its tax).
const inv = (over = {}) => model({
  taxable_value: f(1100000), cgst: f(9000), sgst: f(9000), igst: f(182000), cess: f(30000), grand_total: f(1330000), tcs_amount: f(0), tds_amount: f(0),
  line_items: [ln(600000, 21.2, "IGST", 18.2), ln(300000, 21.2, "IGST", 18.2), ln(100000, 21.2, "IGST", 18.2), ln(100000, 18, "CGST+SGST", 18)],
  ...over,
});

test("IGST lines carrying IGST + cess on a mixed invoice: IGST 182,000 reconciles, cess is taken out, nothing is rewritten", () => {
  const r = run(inv());
  assert.deepEqual(bad(r), []);
  assert.equal(r.summary.verification.level, "verified");
  assert.equal(r.flags.find((x) => x.code === "line_tax_includes_cess").details.cess, 30000);
  const c = r.summary.tax_components;
  assert.deepEqual([c.invoice.igst, c.lines.igst, c.lines.cgst, c.lines.sgst], [182000, 182000, 9000, 9000]);
  const e = norm(inv()).extracted;
  assert.deepEqual([e.igst_amount, e.cgst_amount, e.sgst_amount, e.cess_amount], [182000, 9000, 9000, 30000]);
});

test("the cess may sit in the CGST+SGST lines instead: that family is the one adjusted", () => {
  const l = [ln(600000, 18.2, "IGST", 18.2), ln(300000, 18.2, "IGST", 18.2), ln(100000, 18.2, "IGST", 18.2), ln(100000, 48, "CGST+SGST", 18)];
  // CGST+SGST line tax 48,000 = 18,000 GST + 30,000 cess
  assert.deepEqual(bad(run(inv({ line_items: l }))), []);
});

test("a cess of a different size than the gap is NOT absorbed", () => {
  const r = run(inv({ cess: f(29000), grand_total: f(1329000) }));
  assert.ok(r.flags.some((x) => x.code === "tax_allocation_mismatch"));
  assert.ok(!r.flags.some((x) => x.code === "line_tax_includes_cess"));
});

test("no cess printed: the same lines are a genuine IGST mismatch and say which lines add up to what", () => {
  const r = run(inv({ cess: missing(), grand_total: f(1300000) }));
  const flag = r.flags.find((x) => x.code === "tax_allocation_mismatch");
  assert.ok(flag);
  const igst = flag.details.components.find((c) => c.field === "igst");
  assert.deepEqual([igst.expected, igst.observed], [212000, 182000]);
  assert.deepEqual(igst.lines.map((x) => [x.position, x.taxable, x.rate, x.tax]), [[1, 600000, 18.2, 127200], [2, 300000, 18.2, 63600], [3, 100000, 18.2, 21200]]);
});

test("cess spread over both families is not guessed: the mismatch stays visible", () => {
  const l = [ln(600000, 20, "IGST", 18.2), ln(300000, 20, "IGST", 18.2), ln(100000, 20, "IGST", 18.2), ln(100000, 33, "CGST+SGST", 18)];
  const r = run(inv({ line_items: l }));
  assert.ok(bad(r).length > 0);
});

test("a wrong IGST head with a matching total is still reported", () => {
  const r = run(inv({ igst: f(170000), cgst: f(21000), sgst: f(21000) }));
  assert.ok(bad(r).length > 0);
  assert.notEqual(r.summary.verification.level, "verified");
});

test("helper: single-family, no-cess and UTGST-legacy inputs are left alone", () => {
  const e = { cgst_amount: 9000, sgst_amount: 9000, utgst_amount: null, igst_amount: 182000, cess_amount: 30000 };
  const items = [{ applied_tax_type: "IGST" }, { applied_tax_type: "CGST_UTGST" }];
  assert.equal(removeCessFromLineTaxes(e, items, [212000, 18000], 200), null, "UT lines but no utgst_amount stored: per-family heads unknown");
  assert.equal(removeCessFromLineTaxes({ ...e, cess_amount: null }, [{ applied_tax_type: "IGST" }, { applied_tax_type: "CGST_SGST" }], [212000, 18000], 200), null);
});
