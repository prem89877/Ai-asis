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
  // exchange_rate is the one optional property (only foreign-currency invoices print a rate)
  assert.deepEqual(Object.keys(s.properties).filter((k) => !s.required.includes(k)), ["exchange_rate"]);
  assert.equal(Object.keys(s.properties).length, s.required.length + 1);
});
