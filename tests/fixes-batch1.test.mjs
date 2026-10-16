import test from "node:test";
import assert from "node:assert/strict";
import { parseAmount, cleanNumberText } from "../lib/review/input.ts";
import { toPaise } from "../lib/extraction/normalize.ts";
import { paise } from "../lib/extraction/tax-components.ts";
import { stateCodeFromPlace, STATE_NAMES } from "../lib/review/gst.ts";
import { buildVouchers, DEFAULT_TALLY_CONFIG } from "../lib/tally/build.ts";

const amt = (s) => parseAmount(s, "Amt", 2, 1e12);

test("decimal comma is rejected, never read as thousands", () => {
  for (const bad of ["12,5", "1,50", "1,2345", "12,34", "1,23,45", "1.234,50", "1,,000", ",5"]) {
    const r = amt(bad);
    assert.equal(r.ok, false, bad);
  }
  assert.match(amt("12,5").message, /dot for decimals/);
});

test("thousands separators (western and Indian) and leading dot are accepted", () => {
  const cases = { "1,234": 1234, "1,234.50": 1234.5, "12,34,567.89": 1234567.89, "1,23,456": 123456, "-1,000": -1000, ".5": 0.5, "12.5": 12.5, " 1 234 ": 1234, "0": 0, "100": 100 };
  for (const [raw, want] of Object.entries(cases)) {
    const r = amt(raw);
    assert.equal(r.ok, true, raw);
    assert.equal(r.value, want, raw);
  }
  assert.deepEqual(amt(""), { ok: true, value: null });
  assert.equal(amt("5.").ok, false);
  assert.equal(amt("-").ok, false);
  assert.equal(cleanNumberText("1,23,456.5"), "123456.5");
});

test("toPaise rounds the decimal value, half away from zero", () => {
  assert.equal(toPaise(1.005), 101);
  assert.equal(toPaise(0.285), 29);
  assert.equal(toPaise(1.255), 126);
  assert.equal(toPaise(8.345), 835);
  assert.equal(toPaise(0.025), 3);
  assert.equal(toPaise(-0.025), -3);
  assert.equal(toPaise(-0.004), 0);
  assert.ok(Object.is(toPaise(-0.004), 0));
  assert.equal(toPaise(1180), 118000);
  assert.equal(toPaise(999999999999.99), 99999999999999);
  assert.equal(toPaise(1e-7), 0);
  assert.equal(toPaise(1e21), 1e23);
});

test("toPaise refuses NaN and Infinity; paise() keeps its null-safe behaviour", () => {
  assert.throws(() => toPaise(NaN), RangeError);
  assert.throws(() => toPaise(Infinity), RangeError);
  assert.equal(paise(null), 0);
  assert.equal(paise(undefined), 0);
  assert.equal(paise(NaN), 0);
  assert.equal(paise(1.005), 101);
});

test("Andhra Pradesh by name is the current state 37; the old code 28 still works when printed", () => {
  assert.equal(stateCodeFromPlace("Andhra Pradesh"), "37");
  assert.equal(stateCodeFromPlace("Andhra Pradesh (37)"), "37");
  assert.equal(stateCodeFromPlace("37 - Andhra Pradesh"), "37");
  assert.equal(stateCodeFromPlace("Andhra Pradesh (28)"), "28");
  assert.equal(stateCodeFromPlace("28-Andhra Pradesh"), "28");
  assert.equal(STATE_NAMES["28"], "Andhra Pradesh (old)");
});

test("tally uses the same paise rounding", () => {
  const inv = { id: "i1", status: "verified", invoice_number: "A1", invoice_date: "2026-10-01", vendor_name: "V", vendor_gstin: null, currency: "INR", taxable_amount: 0.285, cgst_amount: null, sgst_amount: null, utgst_amount: null, igst_amount: null, cess_amount: null, total_amount: 0.29, discount_amount: null };
  const { vouchers, skipped } = buildVouchers([inv], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0);
  assert.equal(vouchers[0].entries[0].paise, 29);
});

test("a header without a utgst key (older browser tab) is read as unknown, not NaN", async () => {
  const { computeReviewFlags } = await import("../lib/review/flags.ts");
  const h = { vendor_name: "A", buyer_name: "B", vendor_gstin: null, buyer_gstin: null, invoice_number: "1", invoice_date: "2026-09-15", place_of_supply: null, currency: "INR", document_type: "tax_invoice", taxable_amount: 1000, discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, total_amount: 1180 };
  assert.doesNotThrow(() => computeReviewFlags(h, {}, [], { lowConfidence: 0.8, tolerancePaise: 100 }));
});
