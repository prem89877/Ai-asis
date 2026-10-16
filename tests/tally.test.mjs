import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TALLY_CONFIG, buildVouchers, toTallyCsv, toTallyJson, toTallyXml, validateTallyConfig, voucherBalance, xmlEscape } from "../lib/tally/build.ts";

const inv = (o = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00",
  vendor_name: "Acme & Sons <Traders>", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", buyer_gstin: null, invoice_number: "INV-12",
  invoice_date: "2026-09-15", place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000,
  discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180,
  confidence: 0.9, review_flags: [], verified_at: "2026-10-11T05:00:00+00:00", ...o,
});
const C = DEFAULT_TALLY_CONFIG;

test("every voucher balances to exactly zero (in paise), including round-off", () => {
  const { vouchers, skipped } = buildVouchers([inv(), inv({ id: "2", invoice_number: "B", taxable_amount: 999.5, cgst_amount: 89.96, sgst_amount: 89.96, total_amount: 1179 }), inv({ id: "3", invoice_number: "C", igst_amount: 180, cgst_amount: null, sgst_amount: null })], C);
  assert.equal(skipped.length, 0);
  for (const v of vouchers) assert.equal(voucherBalance(v), 0, v.voucherNumber);
  assert.ok(vouchers.find((v) => v.voucherNumber === "B").entries.some((e) => e.ledger === C.roundOffLedger));
});
test("floating point money never drifts (0.1 + 0.2 style amounts)", () => {
  const { vouchers } = buildVouchers([inv({ taxable_amount: 0.1, cgst_amount: 0.2, sgst_amount: 0.3, total_amount: 0.6 })], C);
  assert.equal(voucherBalance(vouchers[0]), 0);
});
test("unverified, incomplete, non-INR, negative and non-balancing invoices are skipped with a reason", () => {
  const list = [inv({ id: "a", status: "needs_review" }), inv({ id: "b", invoice_number: null }), inv({ id: "c", invoice_date: null }), inv({ id: "d", vendor_name: " " }),
    inv({ id: "e", currency: "USD" }), inv({ id: "f", total_amount: 5000, invoice_number: "F" }), inv({ id: "g", taxable_amount: -5, invoice_number: "G", total_amount: 85 }), inv({ id: "h", total_amount: null, invoice_number: "H" })];
  const { vouchers, skipped } = buildVouchers(list, C);
  assert.equal(vouchers.length, 0);
  assert.equal(skipped.length, list.length);
  assert.ok(skipped.every((s) => s.reason.length > 3));
});
test("same supplier invoice twice in one export is exported once", () => {
  const { vouchers, skipped } = buildVouchers([inv(), inv({ id: "dup" })], C);
  assert.equal(vouchers.length, 1);
  assert.match(skipped[0].reason, /Duplicate/);
});
test("XML is escaped and well-formed: special characters, control chars, structure", () => {
  const { vouchers } = buildVouchers([inv({ vendor_name: "A&B <x> \"q\" 'z'\u0001" })], C);
  const xml = toTallyXml(vouchers, { ...C, companyName: "My & Co" });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(!xml.includes("\u0001"));
  assert.ok(xml.includes("A&amp;B &lt;x&gt; &quot;q&quot; &apos;z&apos;"));
  assert.ok(xml.includes("<SVCURRENTCOMPANY>My &amp; Co</SVCURRENTCOMPANY>"));
  assert.ok(xml.includes("<DATE>20260915</DATE>"));
  // tag balance check (no XML parser available offline)
  const stack = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9._]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === "/") continue;
    if (m[1] === "/") assert.equal(stack.pop(), m[2]); else stack.push(m[2]);
  }
  assert.equal(stack.length, 0);
});
test("XML amounts: party credit positive, debits negative, 2 decimals", () => {
  const { vouchers } = buildVouchers([inv()], C);
  const xml = toTallyXml(vouchers, C);
  const amounts = [...xml.matchAll(/<AMOUNT>([^<]+)<\/AMOUNT>/g)].map((m) => m[1]);
  assert.deepEqual(amounts, ["1180.00", "-1000.00", "-90.00", "-90.00"]);
  assert.ok(xml.includes("<ISPARTYLEDGER>Yes</ISPARTYLEDGER>"));
});
test("JSON and CSV carry the same vouchers; CSV is formula-safe; JSON flags status", () => {
  const { vouchers, skipped } = buildVouchers([inv({ vendor_name: "=HYPERLINK(\"x\")" })], C);
  const j = JSON.parse(toTallyJson(vouchers, skipped, C));
  assert.equal(j.status, "experimental-unverified");
  assert.equal(j.vouchers[0].entries.length, 4);
  const csv = toTallyCsv(vouchers);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 1 + 4);
  assert.ok(csv.includes("'=HYPERLINK"));
});
test("ledger config validation", () => {
  assert.equal(validateTallyConfig(undefined).ok, true);
  assert.equal(validateTallyConfig({ purchaseLedger: "Purchases 18%" }).ok, true);
  assert.equal(validateTallyConfig({ purchaseLedger: "<script>" }).ok, false);
  assert.equal(validateTallyConfig({ cgstLedger: "" }).ok, false);
  assert.equal(validateTallyConfig({ cgstLedger: 5 }).ok, false);
  assert.equal(validateTallyConfig({ companyName: "" }).ok, true);
  assert.equal(validateTallyConfig([]).ok, false);
  assert.equal(xmlEscape("a\u0000b"), "ab");
});

// ---- consistency with the review engine ----
test("round-off up to INR 2.00 (the engine's window) is booked to Round Off, not skipped; more than that is still skipped", () => {
  const { vouchers, skipped } = buildVouchers([
    inv({ id: "a", invoice_number: "RA", total_amount: 1181.9 }), // +1.90
    inv({ id: "b", invoice_number: "RB", total_amount: 1178.1 }), // -1.90
    inv({ id: "c", invoice_number: "RC", total_amount: 1182.5 }), // +2.50: not round-off
  ], C);
  assert.equal(vouchers.length, 2);
  for (const v of vouchers) assert.equal(voucherBalance(v), 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].invoiceNumber, "RC");
});
test("round-off window never exceeds 1% of the value: INR 1.50 on a INR 50 bill is a misread, not round-off", () => {
  const { vouchers, skipped } = buildVouchers([inv({ taxable_amount: 42.37, cgst_amount: 3.81, sgst_amount: 3.81, total_amount: 51.5 })], C);
  assert.equal(vouchers.length, 0);
  assert.equal(skipped.length, 1);
});
test("TCS is booked to its own ledger inside the total", () => {
  const { vouchers, skipped } = buildVouchers([inv({ tcs_amount: 10, total_amount: 1190 })], C);
  assert.equal(skipped.length, 0);
  const v = vouchers[0];
  assert.equal(voucherBalance(v), 0);
  assert.deepEqual(v.entries.find((e) => e.ledger === C.tcsLedger), { ledger: C.tcsLedger, side: "Dr", paise: 1000, isParty: false });
  // a TCS printed with a minus sign is still collected ON TOP of the invoice
  assert.equal(buildVouchers([inv({ tcs_amount: -10, total_amount: 1190 })], C).vouchers.length, 1);
});
test("pre-tax charges kept outside the taxable value get their own ledger; charges already inside it are not booked twice", () => {
  const outside = buildVouchers([inv({ pre_tax_charges: 100, total_amount: 1280 })], C); // 1000 + 100 + 180 (tax computed on 1100 elsewhere is irrelevant here)
  assert.equal(outside.skipped.length, 0);
  assert.equal(voucherBalance(outside.vouchers[0]), 0);
  assert.equal(outside.vouchers[0].entries.find((e) => e.ledger === C.chargesLedger).paise, 10000);
  const inside = buildVouchers([inv({ pre_tax_charges: 100, total_amount: 1180 })], C); // already inside taxable: total balances without it
  assert.equal(inside.skipped.length, 0);
  assert.equal(inside.vouchers[0].entries.some((e) => e.ledger === C.chargesLedger), false);
  // charges and a discount after tax together
  const both = buildVouchers([inv({ pre_tax_charges: 100, discount_amount: 30, total_amount: 1250 })], C);
  assert.equal(both.skipped.length, 0);
  assert.equal(voucherBalance(both.vouchers[0]), 0);
});
test("currency is compared case-insensitively ('inr', ' Inr ' are rupees)", () => {
  const { vouchers, skipped } = buildVouchers([inv({ id: "a", invoice_number: "CA", currency: "inr" }), inv({ id: "b", invoice_number: "CB", currency: " Inr " }), inv({ id: "c", invoice_number: "CC", currency: "usd" })], C);
  assert.equal(vouchers.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /usd/i);
});
test("duplicates: '12/3' and '1/23' are different invoices; a misread GSTIN does not hide a real duplicate", () => {
  const two = buildVouchers([inv({ id: "a", invoice_number: "12/3" }), inv({ id: "b", invoice_number: "1/23" })], C);
  assert.equal(two.vouchers.length, 2);
  const dup = buildVouchers([inv({ id: "a" }), inv({ id: "b", vendor_gstin: "27AAPFU0939F1ZW" })], C);
  assert.equal(dup.vouchers.length, 1);
  assert.match(dup.skipped[0].reason, /Duplicate/);
});
test("new ledger names are validated like the others", () => {
  assert.equal(validateTallyConfig({ tcsLedger: "TCS Receivable", chargesLedger: "Freight and Packing" }).ok, true);
  assert.equal(validateTallyConfig({ chargesLedger: "Freight & Packing" }).ok, false);
});
