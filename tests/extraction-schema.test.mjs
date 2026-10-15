import test from "node:test";
import assert from "node:assert/strict";
import { validateModelOutput, buildResponseSchema } from "../lib/extraction/schema.ts";
import { model, f, missing } from "./helpers.mjs";

test("accepts a well-formed model output", () => {
  assert.equal(validateModelOutput(model()).ok, true);
});

test("rejects non-objects and missing keys", () => {
  assert.equal(validateModelOutput(null).ok, false);
  assert.equal(validateModelOutput([]).ok, false);
  const m = model();
  delete m.grand_total;
  const r = validateModelOutput(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("grand_total")));
});

test("rejects unexpected keys (strict)", () => {
  assert.equal(validateModelOutput({ ...model(), extra: 1 }).ok, false);
  const m = model();
  m.grand_total = { ...m.grand_total, note: "x" };
  assert.equal(validateModelOutput(m).ok, false);
});

test("a missing or unreadable field must not carry a value (no guessing)", () => {
  const m = model({ buyer_gstin: { status: "missing", value: "29ABCDE1234F1Z5", confidence: 0.9 } });
  assert.equal(validateModelOutput(m).ok, false);
  const m2 = model({ cess: { status: "unreadable", value: 0, confidence: 0.1 } });
  assert.equal(validateModelOutput(m2).ok, false);
});

test("a present field needs a value of the right type; genuine zero is allowed", () => {
  assert.equal(validateModelOutput(model({ cess: f(0) })).ok, true);
  assert.equal(validateModelOutput(model({ cess: f("0") })).ok, false); // numeric string rejected
  assert.equal(validateModelOutput(model({ cess: { status: "present", value: null, confidence: 1 } })).ok, false);
  assert.equal(validateModelOutput(model({ supplier_name: f("   ") })).ok, false);
  assert.equal(validateModelOutput(model({ grand_total: f(Number.POSITIVE_INFINITY) })).ok, false);
});

test("confidence and status are validated", () => {
  assert.equal(validateModelOutput(model({ grand_total: f(1, 1.5) })).ok, false);
  assert.equal(validateModelOutput(model({ grand_total: { status: "maybe", value: 1, confidence: 1 } })).ok, false);
});

test("document_type and line item limits", () => {
  assert.equal(validateModelOutput(model({ document_type: "receipt" })).ok, false);
  assert.equal(validateModelOutput(model({ line_items: "none" })).ok, false);
  const many = Array.from({ length: 201 }, () => model().line_items[0]);
  assert.equal(validateModelOutput(model({ line_items: many })).ok, false);
  assert.equal(validateModelOutput(model({ line_items: [] })).ok, true);
});

test("error messages never echo values", () => {
  const r = validateModelOutput(model({ supplier_name: f("SECRET-NAME", 9) }));
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r.errors).includes("SECRET-NAME"));
});

test("response schema lists every field as required", () => {
  const s = buildResponseSchema();
  assert.ok(s.required.includes("grand_total") && s.required.includes("line_items"));
  // Optional extras: only some invoices print them (exchange rate, TCS, TDS, pre-tax charges, round-off, net payable, IRN, ack no, e-way bill no)
  // amount_in_words = the grand total printed in words, used by the grand-total cross-check
  const optional = ["exchange_rate", "utgst_amount", "tcs_amount", "tds_amount", "pre_tax_charges", "round_off_amount", "net_payable_amount", "irn", "ack_no", "eway_bill_no", "amount_in_words"];
  assert.deepEqual(Object.keys(s.properties).filter((k) => !s.required.includes(k)), optional);
  assert.equal(Object.keys(s.properties).length, s.required.length + optional.length);
  // per-item optional hints are described to the model but never required
  const itemProps = Object.keys(s.properties.line_items.items.properties);
  assert.ok(itemProps.includes("discount_type") && itemProps.includes("applied_tax_type"));
  assert.ok(!s.properties.line_items.items.required.includes("discount_type"));
});
