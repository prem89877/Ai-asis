import test from "node:test";
import assert from "node:assert/strict";
import { validateAndRepairGSTIN, computeGstinCheckDigit } from "../lib/extraction/gstin.ts";
import { checkGstin } from "../lib/extraction/normalize.ts";
import { applyReview } from "../lib/review/apply.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";

test("misprinted check digit: 27AABCG5541Q1ZU is repaired to its valid check digit and the raw value is kept", () => {
  const digit = computeGstinCheckDigit("27AABCG5541Q1Z");
  const r = validateAndRepairGSTIN("27AABCG5541Q1ZU");
  assert.equal(r.status, "auto_corrected");
  assert.equal(r.gstin, "27AABCG5541Q1Z" + digit);
  assert.equal(checkGstin(r.gstin).ok, true);
  assert.equal(r.original_raw_gstin, "27AABCG5541Q1ZU");
  assert.equal(r.gstin_auto_corrected, true);
  assert.deepEqual(r.corrected_char, { position: 15, from: "U", to: digit });
});

test("common look-alike misprints in position 15 (6/U, 0/O, 1/I, 2/Z) are all repaired", () => {
  for (const base of ["27AAPFU0939F1Z", "29AABCT1332L1Z", "07AAACH7409R1Z"]) {
    const good = base + computeGstinCheckDigit(base);
    assert.equal(checkGstin(good).ok, true);
    for (const bad of ["U", "O", "I", "Z", "6", "0", "1", "2"]) {
      if (bad === good[14]) continue;
      const r = validateAndRepairGSTIN(base + bad);
      assert.equal(r.gstin, good, `${base}${bad}`);
      assert.equal(r.auto_corrected, true);
    }
  }
});

test("a valid GSTIN is returned unchanged, lower case and spaces are cleaned", () => {
  const r = validateAndRepairGSTIN(" 27aapfu0939f1zv ");
  assert.equal(r.status, "valid");
  assert.equal(r.auto_corrected, false);
  assert.equal(r.gstin, "27AAPFU0939F1ZV");
});

test("nothing is repaired when the first 14 characters are not a GSTIN layout, or the length is wrong", () => {
  for (const bad of ["27AAPFU0939F1ZVX", "27AAPFU0939F1", "", "27AAPFUO939F1ZW", "27AAPFU0939F1AW", "ZZZZZZZZZZZZZZZ"]) {
    const r = validateAndRepairGSTIN(bad);
    assert.equal(r.auto_corrected, false, bad);
    assert.equal(r.gstin, bad.toUpperCase());
    assert.equal(r.valid, false);
  }
});

test("allowRepair: false only reports, never changes the value", () => {
  const r = validateAndRepairGSTIN("27AABCG5541Q1ZU", { allowRepair: false });
  assert.equal(r.auto_corrected, false);
  assert.equal(r.gstin, "27AABCG5541Q1ZU");
});

// ---- Review screen: the raw/validated toggle and the audit note survive edits -------------------------------------------
const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const RAW = "27AAPFU0939F1ZW", FIXED = "27AAPFU0939F1ZV";
const header = () => ({ ...Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null])), vendor_name: "Acme", vendor_gstin: FIXED, buyer_name: "Beta", invoice_number: "A-1", invoice_date: "2026-09-15", place_of_supply: "Karnataka (29)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, total_amount: 1180 });
const fs = () => ({ supplier_gstin: { state: "value", confidence: 0.97, source: "recheck", autoCorrected: { from: RAW, to: FIXED } } });
const flagsFor = (gstin, status) => computeReviewFlags({ ...header(), vendor_gstin: gstin }, status, [], OPTS, new Date("2026-10-11")).filter((x) => x.field === "supplier_gstin");

test("review: the validated GSTIN keeps an info-only audit note, never a warning", () => {
  const fl = flagsFor(FIXED, fs());
  assert.equal(fl.length, 1);
  assert.equal(fl[0].code, "gstin_auto_corrected");
  assert.equal(fl[0].severity, "info");
});

test("review: toggling to the raw GSTIN and back keeps the pair and does not log a manual 'edit'", () => {
  const cur = { header: header(), field_status: fs(), corrected_fields: {}, items: [] };
  const toRaw = applyReview(cur, { header: { vendor_gstin: RAW } }, "u", "2026-10-13T00:00:00Z");
  assert.deepEqual(toRaw.fieldStatus.supplier_gstin.autoCorrected, { from: RAW, to: FIXED });
  assert.equal(toRaw.corrected.vendor_gstin, undefined);
  const back = applyReview({ ...cur, header: toRaw.header, field_status: toRaw.fieldStatus }, { header: { vendor_gstin: FIXED } }, "u", "2026-10-13T00:00:00Z");
  assert.deepEqual(back.fieldStatus.supplier_gstin.autoCorrected, { from: RAW, to: FIXED });
});

test("review: typing some other GSTIN drops the auto-correction record", () => {
  const cur = { header: header(), field_status: fs(), corrected_fields: {}, items: [] };
  const r = applyReview(cur, { header: { vendor_gstin: "29AABCT1332L1ZP" } }, "u", "2026-10-13T00:00:00Z");
  assert.equal(r.fieldStatus.supplier_gstin.autoCorrected, undefined);
  assert.ok(r.corrected.vendor_gstin);
});
