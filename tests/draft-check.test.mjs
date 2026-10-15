// Live warnings for values a person types on the review screen (lib/review/draft-check.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { checkHeaderDraft, checkItemsDraft, countIssues } from "../lib/review/draft-check.ts";
import { HEADER_FIELDS, ITEM_FIELDS } from "../lib/review/fields.ts";

const blankHeader = () => Object.fromEntries(HEADER_FIELDS.map((f) => [f.column, ""]));
const blankItem = () => Object.fromEntries(ITEM_FIELDS.map((f) => [f.key, ""]));
const NOW = new Date("2026-10-15T00:00:00Z");
const base = () => ({ ...blankHeader(), currency: "INR", document_type: "tax_invoice", taxable_amount: "1000", cgst_amount: "90", sgst_amount: "90", total_amount: "1180", vendor_gstin: "27AAPFU0939F1ZV", invoice_date: "2026-10-01", invoice_number: "INV-1" });
const check = (change) => checkHeaderDraft({ ...base(), ...change }, base(), NOW);

test("nothing typed = no warning, even when the saved value itself is odd", () => {
  assert.deepEqual(checkHeaderDraft(base(), base(), NOW), {});
  const odd = { ...base(), vendor_gstin: "BADGSTIN" };
  assert.deepEqual(checkHeaderDraft(odd, odd, NOW), {});
});

test("amounts: a non-number or too many decimals is an error (the server would refuse it), a negative amount a warning", () => {
  assert.equal(check({ taxable_amount: "10O0" }).taxable_amount[0].severity, "error");
  assert.match(check({ taxable_amount: "10O0" }).taxable_amount[0].message, /enter a number/i);
  assert.equal(check({ igst_amount: "1.234" }).igst_amount[0].severity, "error");
  assert.equal(check({ cess_amount: "-5" }).cess_amount[0].severity, "warning");
  assert.equal(check({ cess_amount: "-5", document_type: "credit_note" }).cess_amount, undefined);
});

test("GSTIN: wrong length, wrong pattern and wrong check character are warnings; characters other than letters and digits are an error", () => {
  assert.match(check({ vendor_gstin: "27AAPFU0939F1Z" }).vendor_gstin[0].message, /15 characters\. You typed 14/);
  assert.match(check({ vendor_gstin: "ZZAAPFU0939F1ZV" }).vendor_gstin[0].message, /Not a valid GSTIN pattern/);
  assert.match(check({ vendor_gstin: "27AAPFU0939F1ZA" }).vendor_gstin[0].message, /check character does not match/);
  assert.equal(check({ vendor_gstin: "27AAPFU0939-1ZV" }).vendor_gstin[0].severity, "error");
  assert.equal(check({ vendor_gstin: "27aapfu0939f1zv" }).vendor_gstin, undefined); // lower case is fine, a valid GSTIN
  assert.match(check({ buyer_gstin: "27AAPFU0939F1ZV" }).buyer_gstin[0].message, /same/);
});

test("date: impossible = error, future or before GST = warning", () => {
  assert.equal(check({ invoice_date: "2026-02-31" }).invoice_date[0].severity, "error");
  assert.match(check({ invoice_date: "2027-01-01" }).invoice_date[0].message, /future/);
  assert.match(check({ invoice_date: "2015-05-05" }).invoice_date[0].message, /before GST/);
  assert.equal(check({ invoice_date: "2026-10-02" }).invoice_date, undefined);
});

test("clearing a box that had a value is a warning; currency must be 3 letters", () => {
  assert.match(check({ invoice_number: "" }).invoice_number[0].message, /cleared/);
  assert.equal(check({ currency: "RS" }).currency[0].severity, "error");
  assert.match(check({ invoice_number: "INV@1" }).invoice_number[0].message, /Unusual character/);
});

test("amounts that belong together: total, CGST = SGST, IGST with CGST/SGST", () => {
  assert.match(check({ total_amount: "1280" }).total_amount[0].message, /1180\.00.*1280\.00/);
  assert.equal(check({ total_amount: "1180.5" }).total_amount, undefined); // inside the rupee tolerance
  assert.ok(check({ cgst_amount: "100" }).cgst_amount.some((x) => /normally equal/.test(x.message)));
  assert.ok(check({ igst_amount: "180" }).igst_amount.some((x) => /not charged on the same invoice/.test(x.message)));
  assert.equal(check({ total_amount: "99999", currency: "USD" }).total_amount, undefined); // foreign currency: not compared
  assert.equal(checkHeaderDraft(base(), { ...base(), vendor_name: "x" }, NOW).total_amount, undefined); // total fields unchanged: no maths warning
});

test("line items: format errors, HSN, rate, and the line maths", () => {
  const row = { ...blankItem(), quantity: "2", unit_price: "500", taxable_amount: "1000", gst_rate: "18", gst_amount: "180", line_total: "1180", hsn_code: "8517" };
  const calc = (change, baseRow = row) => checkItemsDraft([{ ...row, ...change }], [baseRow], "INR")[0];
  assert.deepEqual(calc({}), {});
  assert.equal(calc({ quantity: "2x" }).quantity[0].severity, "error");
  assert.equal(calc({ hsn_code: "85" }).hsn_code[0].severity, "error");
  assert.equal(calc({ hsn_code: "85171" }).hsn_code[0].severity, "warning");
  assert.equal(calc({ gst_rate: "180" }).gst_rate[0].severity, "error");
  assert.match(calc({ unit_price: "600" }).taxable_amount[0].message, /1200\.00.*1000\.00/);
  assert.match(calc({ gst_amount: "150" }).gst_amount[0].message, /18% of ₹1000\.00 = ₹180\.00/);
  assert.match(calc({ line_total: "1300" }).line_total[0].message, /1180\.00/);
  assert.deepEqual(checkItemsDraft([{ ...row, unit_price: "6" }], [row], "USD")[0].taxable_amount, undefined); // USD: unit price is not rupees
});

test("a new row counts every filled box as typed; counts split errors and warnings", () => {
  const rows = checkItemsDraft([{ ...blankItem(), quantity: "abc", hsn_code: "85171" }], [], "INR");
  assert.equal(rows[0].quantity[0].severity, "error");
  assert.deepEqual(countIssues({}, rows), { errors: 1, warnings: 1 });
});
