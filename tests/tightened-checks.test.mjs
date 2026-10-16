// Regression tests for the tightened checks: discount guesses, half-tax rule by regime, line-fix evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { validateLineItem } from "../lib/extraction/arithmetic.ts";
import { checkTaxHeads } from "../lib/extraction/tax-math.ts";

const line = (o = {}) => ({ description: "x", hsn_code: null, quantity: 10, unit: null, unit_price: 1000, discount_amount: null, taxable_amount: null, gst_rate: 18, gst_amount: null, line_total: null, field_status: {}, ...o });
const rc = { tolerancePaise: 100, foreign: false, explicitRate: null, impliedRate: null };

test("discount of unknown type: a wrong taxable that is only INR 0.80 off a guessed reading no longer passes", () => {
  // 10 x 1000 = 10,000, discount 10 -> flat 9,990 / percent 9,000 / ignored 10,000. 9,000.80 is within INR 1 of the percent guess only.
  assert.equal(validateLineItem(line({ discount_amount: 10, taxable_amount: 9000.8 }), 1, rc).status, "fail");
  assert.equal(validateLineItem(line({ discount_amount: 10, taxable_amount: 9000 }), 1, rc).status, "pass"); // exact percent reading still ok
  assert.equal(validateLineItem(line({ discount_amount: 10, taxable_amount: 9990.8 }), 1, rc).status, "pass"); // flat reading keeps the full INR 1
});

test("explicit discount type: gross is not accepted as a second answer", () => {
  assert.equal(validateLineItem(line({ discount_amount: 500, discount_type: "FLAT", taxable_amount: 10000 }), 1, rc).status, "fail");
  assert.equal(validateLineItem(line({ discount_amount: 500, discount_type: "FLAT", taxable_amount: 9500 }), 1, rc).status, "pass");
});

const inv = (o) => ({ vendor_gstin: "27AAAAA0000A1Z5", place_of_supply: "27-Maharashtra", document_type: "tax_invoice", currency: "INR", exchange_rate: null, cgst_amount: null, sgst_amount: null, utgst_amount: null, igst_amount: null, taxable_amount: 10000, ...o });
const taxLine = (gst) => line({ taxable_amount: 10000, gst_rate: 18, gst_amount: gst, field_status: {} });

test("IGST (inter-state) invoice: a line tax at 9 % instead of 18 % is flagged", () => {
  const e = inv({ place_of_supply: "29-Karnataka", igst_amount: 1800 });
  const f = checkTaxHeads(e, [taxLine(900)], 100).flags.filter((x) => x.code === "item_tax_rate_mismatch");
  assert.equal(f.length, 1);
  assert.equal(checkTaxHeads(e, [taxLine(1800)], 100).flags.filter((x) => x.code === "item_tax_rate_mismatch").length, 0);
});

test("intra-state invoice: a line that shows one head (half) is still accepted", () => {
  const e = inv({ cgst_amount: 900, sgst_amount: 900 });
  assert.equal(checkTaxHeads(e, [taxLine(900)], 100).flags.filter((x) => x.code === "item_tax_rate_mismatch").length, 0);
});

test("regime unknown: half is accepted only when the invoice shows CGST / SGST and no IGST", () => {
  const unknown = { vendor_gstin: null, place_of_supply: null };
  assert.equal(checkTaxHeads(inv({ ...unknown, cgst_amount: 900, sgst_amount: 900 }), [taxLine(900)], 100).flags.filter((x) => x.code === "item_tax_rate_mismatch").length, 0);
  assert.equal(checkTaxHeads(inv({ ...unknown, igst_amount: 1800 }), [taxLine(900)], 100).flags.filter((x) => x.code === "item_tax_rate_mismatch").length, 1);
});
