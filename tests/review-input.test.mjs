import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewInput, parseAmount } from "../lib/review/input.ts";
import { applyReview } from "../lib/review/apply.ts";
import { HEADER_COLUMNS, ITEM_FIELDS } from "../lib/review/fields.ts";

const base = { expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save" };

test("rejects unknown top-level and header keys", () => {
  assert.equal(parseReviewInput({ ...base, extra: 1 }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { firm_id: "x" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { verified_by: "x" } }).ok, false);
});

test("requires a known action and a timestamp", () => {
  assert.equal(parseReviewInput({ ...base, action: "delete" }).ok, false);
  assert.equal(parseReviewInput({ action: "save" }).ok, false);
  assert.equal(parseReviewInput({ ...base, expectedUpdatedAt: "not a date" }).ok, false);
  assert.equal(parseReviewInput(null).ok, false);
  assert.equal(parseReviewInput([]).ok, false);
});

test("normalizes header values without rounding", () => {
  const r = parseReviewInput({
    ...base,
    header: { vendor_gstin: " 27aapfu0939f1zv ", invoice_date: "2026-09-15", total_amount: "1,180.50", currency: "inr", vendor_name: "  Acme   Traders ", cess_amount: "" },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.header, {
    vendor_gstin: "27AAPFU0939F1ZV", invoice_date: "2026-09-15", total_amount: 1180.5, currency: "INR", vendor_name: "Acme Traders", cess_amount: null,
  });
});

test("refuses values that would need rounding or are not numbers", () => {
  assert.equal(parseReviewInput({ ...base, header: { total_amount: "10.005" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { total_amount: "abc" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { total_amount: 1e20 } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { total_amount: { a: 1 } } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { invoice_date: "2026-02-30" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { invoice_date: "15/09/2026" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { currency: "RUPEES" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { document_type: "not_an_invoice" } }).ok, false);
  assert.equal(parseReviewInput({ ...base, header: { vendor_gstin: "27-AAPFU" } }).ok, false);
});

test("accepts an invalid-looking GSTIN so it can be flagged rather than silently dropped", () => {
  const r = parseReviewInput({ ...base, header: { vendor_gstin: "27AAPFU0939F1ZX" } });
  assert.equal(r.ok, true);
});

test("negative zero becomes zero; negative credit-note amounts are allowed", () => {
  assert.equal(Object.is(parseAmount("-0", "x", 2, 1e9).value, 0), true);
  assert.equal(parseAmount("-100.25", "x", 2, 1e9).value, -100.25);
});

test("items: validates HSN, rate range, caps count", () => {
  const item = (o = {}) => ({ description: "W", hsn_code: "8471", quantity: 1, unit: "Nos", unit_price: 10, discount_amount: null, taxable_amount: 10, gst_rate: 18, gst_amount: 1.8, line_total: 11.8, ...o });
  assert.equal(parseReviewInput({ ...base, items: [item()] }).ok, true);
  assert.equal(parseReviewInput({ ...base, items: [item({ hsn_code: "12" })] }).ok, false);
  assert.equal(parseReviewInput({ ...base, items: [item({ gst_rate: 101 })] }).ok, false);
  assert.equal(parseReviewInput({ ...base, items: [item({ unit_price: "1.12345" })] }).ok, false);
  assert.equal(parseReviewInput({ ...base, items: [{ ...item(), firm_id: "x" }] }).ok, false);
  assert.equal(parseReviewInput({ ...base, items: Array.from({ length: 301 }, () => item()) }).ok, false);
});

const current = () => ({
  header: Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null])),
  field_status: { supplier_name: { state: "value", confidence: 0.6 }, grand_total: { state: "value", confidence: 0.5 } },
  corrected_fields: {},
  items: [],
  updated_at: "x",
});

test("applyReview: only changed fields are touched, first original is kept, status becomes certain", () => {
  const cur = current();
  cur.header.vendor_name = "Acme Trader";
  cur.header.total_amount = 1180;
  const parsed = parseReviewInput({ ...base, header: { vendor_name: "Acme Traders", total_amount: 1180, invoice_number: "INV-9/A" } }).value;
  const out = applyReview(cur, parsed, "user-1", "2026-10-11T10:00:00Z");
  assert.deepEqual(Object.keys(out.changes.header).sort(), ["invoice_number", "vendor_name"]);
  assert.equal(out.corrected.vendor_name.original, "Acme Trader");
  assert.equal(out.fieldStatus.supplier_name.confidence, 1);
  assert.equal(out.fieldStatus.grand_total.confidence, 0.5); // unchanged field keeps the model's own confidence
  assert.equal(out.invoiceNumberNorm, "INV-9-A");
  // second edit keeps the first original
  const cur2 = { ...cur, header: out.header, corrected_fields: out.corrected };
  const out2 = applyReview(cur2, parseReviewInput({ ...base, header: { vendor_name: "Acme Traders Pvt" } }).value, "user-1", "later");
  assert.equal(out2.corrected.vendor_name.original, "Acme Trader");
});

test("applyReview: clearing a field marks it missing; entering 0 marks it zero", () => {
  const cur = current();
  cur.header.cgst_amount = 90;
  cur.header.igst_amount = null;
  const out = applyReview(cur, parseReviewInput({ ...base, header: { cgst_amount: null, igst_amount: 0 } }).value, "u", "t");
  assert.equal(out.fieldStatus.cgst.state, "missing");
  assert.equal(out.fieldStatus.igst.state, "zero");
});

test("applyReview: unchanged items are not rewritten", () => {
  const cur = current();
  const row = { description: "W", hsn_code: "8471", quantity: 2, unit: "Nos", unit_price: 500, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180 };
  cur.items = [{ ...row, field_status: {} }];
  const same = applyReview(cur, parseReviewInput({ ...base, items: [row] }).value, "u", "t");
  assert.equal(same.items, null);
  const edited = applyReview(cur, parseReviewInput({ ...base, items: [{ ...row, quantity: 3 }] }).value, "u", "t");
  assert.equal(edited.items.length, 1);
  assert.equal(edited.items[0].field_status.quantity.confidence, 1);
  assert.equal(ITEM_FIELDS.every((f) => f.statusKey in edited.items[0].field_status), true);
});
