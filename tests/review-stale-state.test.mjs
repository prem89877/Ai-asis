// A computed round-off must not go stale after an edit, and the review request carries which original row each line came from.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { refreshComputedRoundOff, computeReviewFlags } from "../lib/review/flags.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { parseReviewInput } from "../lib/review/input.ts";
import { f, model } from "./helpers.mjs";

const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const FS = Object.fromEntries(["supplier_name", "supplier_gstin", "buyer_name", "invoice_number", "invoice_date", "taxable_value", "grand_total", "cgst", "sgst"].map((k) => [k, { state: "value", confidence: 1 }]));
const header = (over = {}) => ({
  ...Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null])),
  vendor_name: "Acme", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", invoice_number: "INV-1", invoice_date: "2026-09-15",
  place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, total_amount: 1180, ...over,
});
const item = (o = {}) => ({ description: "W", hsn_code: "8471", quantity: 2, unit: "Nos", unit_price: 500, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180, field_status: {}, ...o });
const COMPUTED = { state: "value", confidence: 1, source: "computed" };
const base = { expectedUpdatedAt: "2026-10-11T10:00:00.123456+00:00", action: "save" };

test("a computed round-off is not treated as printed by the total check", () => {
  const data = normalizeExtraction(model({ grand_total: f(1180) }), { model: "t", now: new Date("2026-10-11") });
  data.extracted.round_off_amount = 0.4;
  data.extracted.field_status = { ...data.extracted.field_status, round_off_amount: COMPUTED };
  const r = validateInvoice(data, { tolerancePaise: 100 });
  assert.equal(r.summary.total_check, "passed");
  assert.equal(r.summary.round_off_applied, null); // nothing to absorb now: the old 0.40 is not reused as a "printed" figure
  assert.deepEqual(r.patch, {});
  // the same figure printed on the invoice IS used
  data.extracted.field_status = { ...data.extracted.field_status, round_off_amount: { state: "value", confidence: 1 } };
  const printed = validateInvoice(data, { tolerancePaise: 100 });
  assert.equal(printed.summary.adjustments.round_off, 0.4);
});

test("after an edit the computed round-off is recomputed, removed, or left alone when typed by a person", () => {
  const items = [item()];
  const fs = { ...FS, round_off_amount: COMPUTED };
  // total now ties exactly: the old 0.40 disappears
  const tied = refreshComputedRoundOff(header({ round_off_amount: 0.4, total_amount: 1180 }), fs, items, OPTS);
  assert.equal(tied.header.round_off_amount, null);
  assert.ok(!("round_off_amount" in tied.fieldStatus));
  // total moved by 0.50: recomputed from the current values, still marked computed
  const moved = refreshComputedRoundOff(header({ round_off_amount: 0.4, total_amount: 1180.5 }), fs, items, OPTS);
  assert.equal(moved.header.round_off_amount, 0.5);
  assert.equal(moved.fieldStatus.round_off_amount.source, "computed");
  // typed by a reviewer, or printed: untouched
  const human = refreshComputedRoundOff(header({ round_off_amount: 0.4, total_amount: 1180 }), { ...FS, round_off_amount: { state: "value", confidence: 1, source: "human" } }, items, OPTS);
  assert.equal(human.header.round_off_amount, 0.4);
  // and the flags after the refresh agree with the values
  const flags = computeReviewFlags(tied.header, tied.fieldStatus, items, OPTS);
  assert.ok(!flags.some((x) => x.code === "arithmetic_total_mismatch"));
});

test("review request: itemSources must match the rows sent", () => {
  const row = { description: "W", hsn_code: "8471", quantity: 1, unit: "Nos", unit_price: 1, discount_amount: null, taxable_amount: 1, gst_rate: 18, gst_amount: 0.18, line_total: 1.18 };
  const ok = parseReviewInput({ ...base, items: [row, row], itemSources: [2, null] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.itemSources, [2, null]);
  assert.equal(parseReviewInput({ ...base, items: [row] }).value.itemSources, null); // older page
  for (const bad of [[1], [0, 1], [1.5, 1], ["1", 1], [1, 2, 3]]) assert.equal(parseReviewInput({ ...base, items: [row, row], itemSources: bad }).ok, false, JSON.stringify(bad));
  assert.equal(parseReviewInput({ ...base, itemSources: [1] }).ok, false); // sources without rows
});
