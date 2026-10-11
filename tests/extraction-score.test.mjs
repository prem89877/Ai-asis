import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { judge, scoreExtraction } from "../lib/extraction/score.ts";
import { validateModelOutput } from "../lib/extraction/schema.ts";
import { f, missing, unreadable } from "./helpers.mjs";

// Build a model output that reproduces the truth file exactly (an "oracle"), to prove the scorer and
// fixtures agree with each other. This validates the harness, NOT the AI model.
function oracle(truth) {
  const field = (v) => (v === null || v === undefined ? missing() : f(v));
  const keys = ["currency","supplier_name","supplier_gstin","buyer_name","buyer_gstin","invoice_number","invoice_date","place_of_supply","taxable_value","discount_total","cgst","sgst","igst","cess","grand_total"];
  const out = { document_type: "tax_invoice", line_items: [] };
  for (const k of keys) out[k] = field(truth[k]);
  const ik = ["description","hsn_sac","unit","quantity","unit_price","discount","taxable_value","gst_rate","tax_amount","line_total"];
  out.line_items = (truth.line_items ?? []).map((t) => Object.fromEntries(ik.map((k) => [k, field(t[k])])));
  return out;
}

test("judge covers every verdict", () => {
  assert.equal(judge("A b", f(" a  B ")), "correct");
  assert.equal(judge(10, f(10.004)), "correct");
  assert.equal(judge(10, f(11)), "wrong");
  assert.equal(judge(10, missing()), "abstained");
  assert.equal(judge(10, unreadable()), "abstained");
  assert.equal(judge(null, f("x")), "invented");
  assert.equal(judge(null, missing()), "correct_missing");
  assert.equal(judge(0, f(0)), "correct"); // genuine zero is a real value
  assert.equal(judge(0, missing()), "abstained"); // absent is not zero
});

test("every fixture has a truth file and the oracle scores 100% on it", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  const truths = readdirSync(dir).filter((n) => n.endsWith(".truth.json"));
  assert.ok(truths.length >= 6);
  for (const name of truths) {
    const truth = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    readFileSync(new URL(truth.file, dir)); // the document exists
    const out = oracle(truth);
    assert.equal(validateModelOutput(out).ok, true, name);
    const s = scoreExtraction(truth, out);
    for (const t of [...Object.values(s.fields), ...Object.values(s.itemFields)]) {
      assert.equal(t.wrong + t.abstained + t.invented, 0, name);
    }
    assert.ok(s.itemCount.match);
  }
});

test("scorer detects a wrong total, an invented GSTIN and a dropped field", () => {
  const truth = JSON.parse(readFileSync(new URL("./fixtures/01-intra-state-grid.truth.json", import.meta.url), "utf8"));
  const out = oracle(truth);
  out.grand_total = f(3899);
  out.buyer_gstin = f("27AAAAA0000A1Z5"); // truth: absent? (fixture 01 has a buyer GSTIN, so make it wrong instead)
  out.supplier_name = missing();
  const s = scoreExtraction(truth, out);
  assert.equal(s.fields.grand_total.wrong, 1);
  assert.equal(s.fields.supplier_name.abstained, 1);
  assert.equal(s.fields.buyer_gstin.wrong, 1);

  const t3 = JSON.parse(readFileSync(new URL("./fixtures/03-bill-of-supply.truth.json", import.meta.url), "utf8"));
  const o3 = oracle(t3);
  o3.supplier_gstin = f("27ABCDE1234F1Z5");
  assert.equal(scoreExtraction(t3, o3).fields.supplier_gstin.invented, 1);
});

test("item count mismatch is reported", () => {
  const truth = JSON.parse(readFileSync(new URL("./fixtures/02-inter-state-discount.truth.json", import.meta.url), "utf8"));
  const out = oracle(truth);
  out.line_items.pop();
  const s = scoreExtraction(truth, out);
  assert.equal(s.itemCount.match, false);
  assert.ok(s.itemFields.description.abstained >= 1);
});
