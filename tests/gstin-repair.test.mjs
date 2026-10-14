import test from "node:test";
import assert from "node:assert/strict";
import { validateGstin, computeGstinCheckDigit, suggestGstinFixes } from "../lib/extraction/gstin.ts";
import { checkGstin } from "../lib/extraction/normalize.ts";
import { applyReview } from "../lib/review/apply.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";

test("misprinted check digit: validateGstin keeps the raw value and only PROPOSES the valid check digit", () => {
  const digit = computeGstinCheckDigit("27AABCG5541Q1Z");
  const r = validateGstin("27AABCG5541Q1ZU");
  assert.equal(r.status, "checksum_failed");
  assert.equal(r.valid, false);
  assert.equal(r.gstin, "27AABCG5541Q1ZU"); // never replaced
  assert.equal(r.raw, "27AABCG5541Q1ZU");
  assert.deepEqual(r.proposed, ["27AABCG5541Q1Z" + digit]);
  assert.equal(checkGstin(r.proposed[0]).ok, true);
});

test("look-alike misprints in position 15 are proposed, never applied", () => {
  for (const base of ["27AAPFU0939F1Z", "29AABCT1332L1Z", "07AAACH7409R1Z"]) {
    const good = base + computeGstinCheckDigit(base);
    for (const bad of ["U", "O", "I", "Z", "6", "0", "1", "2"]) {
      if (bad === good[14]) continue;
      const r = validateGstin(base + bad);
      assert.equal(r.gstin, base + bad, `${base}${bad}`);
      assert.ok(r.proposed.includes(good));
    }
  }
});

test("a valid GSTIN is returned unchanged, lower case and spaces are cleaned", () => {
  const r = validateGstin(" 27aapfu0939f1zv ");
  assert.equal(r.status, "valid");
  assert.equal(r.valid, true);
  assert.equal(r.gstin, "27AAPFU0939F1ZV");
  assert.equal(r.proposed, undefined);
});

test("wrong length or layout: kept as read and reported; nothing is repaired", () => {
  for (const bad of ["27AAPFU0939F1ZVX", "27AAPFU0939F1", "27AAPFUO939F1ZW", "27AAPFU0939F1AW", "ZZZZZZZZZZZZZZZ"]) {
    const r = validateGstin(bad);
    assert.equal(r.status, "format_invalid", bad);
    assert.equal(r.gstin, bad.toUpperCase());
    assert.equal(r.valid, false);
  }
});

test("missing GSTIN: reported as missing, no value is invented", () => {
  for (const none of ["", "   ", null, undefined]) {
    const r = validateGstin(none);
    assert.equal(r.status, "missing");
    assert.equal(r.gstin, "");
    assert.equal(r.proposed, undefined);
  }
});

test("a single ambiguous character (O/0, I/1, B/8, S/5) is a suggestion only", () => {
  const good = "27AAPFU0939F1ZV";
  const printed = "27AAPFU0939F1ZV".replace("0939", "O939"); // letter O in a digit position: layout fails
  const r = validateGstin(printed);
  assert.equal(r.status, "format_invalid");
  assert.equal(r.gstin, printed);
  assert.ok(suggestGstinFixes(printed).includes(good));
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
