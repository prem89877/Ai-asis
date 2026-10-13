// Negative lines (returns, rebates, trade-volume discounts): judged once per invoice, never flagged line by line.
// Regression for the repeated review notes "Item 9: This line is negative..." and the misread-minus-sign cases.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice, validateNegativeLines } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { f, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const sale = (n = 2000) => item({ quantity: f(2), unit_price: f(n / 2), taxable_value: f(n), tax_amount: f(n * 0.18), line_total: f(n * 1.18) });
const rebate = (n, desc = "Volume rebate") => item({ description: f(desc), quantity: f(1), unit_price: f(n), taxable_value: f(-n), tax_amount: f(-n * 0.18), line_total: f(-n * 1.18) });

test("two negative lines that tie to the invoice: no flag at all", () => {
  const m = model({ taxable_value: f(1000), cgst: f(90), sgst: f(90), grand_total: f(1180), line_items: [sale(2000), rebate(600), rebate(400, "Return")] });
  const r = validateInvoice(norm(m), OPTS);
  assert.deepEqual(r.flags.filter((x) => /negative/.test(x.code)), []);
  assert.deepEqual(r.summary.negative_lines, { positions: [2, 3], status: "confirmed" });
});

test("negative lines that cannot be tied to anything: ONE note listing the items, not one note per item", () => {
  const items = [sale(), rebate(300), rebate(200)];
  const e = norm(model({ taxable_value: { status: "missing", value: null, confidence: 0.9 }, line_items: items })).extracted;
  const stored = norm(model({ line_items: items }));
  const neg = validateNegativeLines({ ...stored.extracted, taxable_amount: null }, stored.items, 100);
  assert.equal(neg.status, "unconfirmed");
  assert.equal(neg.flags.length, 1);
  assert.equal(neg.flags[0].severity, "info");
  assert.equal(neg.flags[0].itemPosition, undefined);
  assert.match(neg.flags[0].message, /Items 2, 3 are negative lines/);
  assert.equal(e.review_flags.some((x) => x.code === "negative_line_item"), false);
});

test("credit and debit notes: negative figures are expected, nothing is said", () => {
  const m = model({ document_type: "credit_note", taxable_value: f(-1000), cgst: f(-90), sgst: f(-90), grand_total: f(-1180), line_items: [item({ taxable_value: f(-1000), tax_amount: f(-180), line_total: f(-1180) })] });
  const r = validateInvoice(norm(m), OPTS);
  assert.deepEqual(r.flags.filter((x) => /negative/.test(x.code)), []);
  assert.equal(r.summary.negative_lines, undefined);
});

test("a minus sign on some amounts of a line but not on others is a warning (misread dash)", () => {
  const odd = item({ quantity: f(1), unit_price: f(500), taxable_value: f(-500), tax_amount: f(90), line_total: f(590) });
  const m = model({ taxable_value: f(1500), cgst: f(135), sgst: f(135), grand_total: f(1770), line_items: [sale(), odd] });
  const r = validateInvoice(norm(m), OPTS);
  const fl = r.flags.filter((x) => x.code === "negative_line_suspect");
  assert.equal(fl.length, 1);
  assert.equal(fl[0].severity, "warning");
  assert.deepEqual(fl[0].details.positions, [2]);
  assert.equal(r.summary.negative_lines.status, "suspect");
});

test("a line that is negative but the invoice adds up only if it is positive: warning", () => {
  // printed: 2000 + 500 = 2500. The 500 line was read as negative.
  const wrongSign = item({ quantity: f(1), unit_price: f(500), taxable_value: f(-500), tax_amount: f(-90), line_total: f(-590) });
  const m = model({ taxable_value: f(2500), cgst: f(225), sgst: f(225), grand_total: f(2950), line_items: [sale(), wrongSign] });
  const r = validateInvoice(norm(m), OPTS);
  assert.ok(r.flags.some((x) => x.code === "negative_line_suspect" && x.severity === "warning"));
  assert.match(r.flags.find((x) => x.code === "negative_line_suspect").message, /only if they are positive/);
});

test("extraction no longer adds a 'negative_line_item' flag for each line", () => {
  const n = norm(model({ taxable_value: f(1500), cgst: f(135), sgst: f(135), grand_total: f(1770), line_items: [sale(), rebate(500)] }));
  assert.equal(n.extracted.review_flags.some((x) => x.code === "negative_line_item"), false);
});
