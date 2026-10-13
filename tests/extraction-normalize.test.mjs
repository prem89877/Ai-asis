import test from "node:test";
import assert from "node:assert/strict";
import { checkGstin, gstinChecksumChar, normalizeIsoDate, normalizeHsn, normalizeInvoiceNumber, normalizeExtraction, toPaise } from "../lib/extraction/normalize.ts";
import { runChecks, outcomeFor } from "../lib/extraction/checks.ts";
import { model, item, f, missing, unreadable } from "./helpers.mjs";

const NOW = new Date("2026-10-11T00:00:00Z");
const run = (m, opts = {}) => {
  const { extracted, items } = normalizeExtraction(m, { model: "test", now: NOW });
  const flags = [...extracted.review_flags, ...runChecks(extracted, items, { lowConfidence: 0.8, tolerancePaise: 100, ...opts })];
  return { extracted, items, flags, codes: flags.map((x) => x.code) };
};

test("GSTIN checksum", () => {
  assert.equal(checkGstin("27AAPFU0939F1ZV").ok, true);
  assert.equal(gstinChecksumChar("27AAPFU0939F1Z"), "V");
  const bad = checkGstin("27AAPFU0939F1ZW");
  assert.deepEqual(bad, { ok: false, reason: "checksum" });
  assert.deepEqual(checkGstin("1234"), { ok: false, reason: "format" });
});

test("date, HSN and invoice number normalizers", () => {
  assert.equal(normalizeIsoDate("2026-02-29"), null);
  assert.equal(normalizeIsoDate("2028-02-29"), "2028-02-29");
  assert.equal(normalizeIsoDate("15/09/2026"), null);
  assert.equal(normalizeHsn("8471 30"), "847130");
  assert.equal(normalizeHsn("84"), null);
  assert.equal(normalizeInvoiceNumber("inv/001"), "INV001");
  assert.equal(normalizeInvoiceNumber("---"), null);
  assert.equal(toPaise(1234.56), 123456);
});

test("clean invoice has no warnings or errors and completes", () => {
  const clean = run(model());
  assert.deepEqual(clean.flags.filter((x) => x.severity !== "info"), []);
  assert.equal(outcomeFor(clean.flags), "completed");
  assert.equal(clean.extracted.currency, "INR");
});

test("missing vs unreadable vs genuine zero are kept apart", () => {
  const r = run(model({ cess: f(0), igst: missing(), discount_total: unreadable() }));
  assert.equal(r.extracted.field_status.cess.state, "zero");
  assert.equal(r.extracted.cess_amount, 0);
  assert.equal(r.extracted.field_status.igst.state, "missing");
  assert.equal(r.extracted.igst_amount, null);
  assert.equal(r.extracted.field_status.discount_total.state, "unreadable");
  assert.equal(r.extracted.discount_amount, null);
  assert.ok(r.codes.includes("unreadable_field"));
});

test("missing currency stays null (never defaulted to INR)", () => {
  const r = run(model({ currency: missing() }));
  assert.equal(r.extracted.currency, null);
});

test("required fields missing => error and needs_review", () => {
  const r = run(model({ invoice_number: missing(), grand_total: unreadable() }));
  assert.ok(r.flags.some((x) => x.code === "missing_required" && x.field === "invoice_number" && x.severity === "error"));
  assert.ok(r.flags.some((x) => x.code === "unreadable_field" && x.field === "grand_total"));
  assert.equal(outcomeFor(r.flags), "needs_review");
});

test("invalid date is not saved and is flagged", () => {
  const r = run(model({ invoice_date: f("15/09/2026") }));
  assert.equal(r.extracted.invoice_date, null);
  assert.equal(r.extracted.field_status.invoice_date.state, "invalid");
  assert.ok(r.codes.includes("invalid_date"));
  assert.ok(r.codes.includes("missing_required") === false);
});

test("implausible dates are flagged but kept", () => {
  assert.ok(run(model({ invoice_date: f("2015-01-01") })).codes.includes("implausible_date"));
  assert.ok(run(model({ invoice_date: f("2027-05-01") })).codes.includes("implausible_date"));
  assert.equal(run(model({ invoice_date: f("2026-10-11") })).extracted.invoice_date, "2026-10-11");
});

test("bad GSTIN is flagged and kept as read (upper-cased)", () => {
  const r = run(model({ supplier_gstin: f("27aapfu0939f1zw") }));
  assert.equal(r.extracted.vendor_gstin, "27AAPFU0939F1ZW");
  assert.ok(r.flags.some((x) => x.code === "invalid_gstin" && x.details.reason === "checksum"));
});

test("arithmetic mismatch flags the total and never edits amounts", () => {
  const r = run(model({ grand_total: f(1250) }));
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(flag);
  assert.equal(flag.severity, "error");
  assert.equal(r.extracted.total_amount, 1250); // extracted value untouched
  assert.equal(r.extracted.cgst_amount, 90);
  assert.equal(outcomeFor(r.flags), "needs_review");
});

test("rounding up to INR 2.00 is absorbed as round-off, beyond it is flagged", () => {
  assert.ok(!run(model({ grand_total: f(1180.6) })).codes.includes("arithmetic_total_mismatch"));
  // INR 1.50 off: inside the INR 2.00 round-off window, so the total PASSES (and an info note records the amount)
  const r = run(model({ grand_total: f(1181.5) }));
  assert.ok(!r.codes.includes("arithmetic_total_mismatch"));
  assert.ok(r.codes.includes("round_off_absorbed"));
  // INR 2.50 off: a real mismatch
  assert.ok(run(model({ grand_total: f(1182.5) })).codes.includes("arithmetic_total_mismatch"));
  assert.ok(!run(model({ grand_total: f(1182.5) }), { tolerancePaise: 300 }).codes.includes("arithmetic_total_mismatch"));
});

test("total check accepts bill-level discount either way", () => {
  // taxable shown before discount: total = taxable - discount + taxes
  const r = run(model({ taxable_value: f(1100), discount_total: f(100), line_items: [item({ taxable_value: f(1100), unit_price: f(550) })] }));
  assert.ok(!r.codes.includes("arithmetic_total_mismatch"));
});

test("missing tax lines are not treated as zero silently", () => {
  const r = run(model({ cgst: missing(), sgst: missing() }));
  const flag = r.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(flag);
  assert.deepEqual(flag.details.taxFieldsNotFound.sort(), ["cess", "cgst", "igst", "sgst"]);
});

test("no tax and total equals taxable passes (bill of supply)", () => {
  const r = run(model({ document_type: "bill_of_supply", cgst: missing(), sgst: missing(), grand_total: f(1000) }));
  assert.ok(!r.codes.includes("arithmetic_total_mismatch"));
});

test("line and subtotal mismatches", () => {
  const badLine = run(model({ line_items: [item({ quantity: f(3) })] }));
  assert.ok(badLine.flags.some((x) => x.code === "arithmetic_line_mismatch" && x.itemPosition === 1));
  const badSub = run(model({ line_items: [item({ taxable_value: f(900), unit_price: f(450) })] }));
  assert.ok(badSub.codes.includes("arithmetic_subtotal_mismatch"));
});

test("IGST together with CGST/SGST is no longer a blanket warning; it is checked line by line", () => {
  const r = run(model({ igst: f(180) }));
  assert.ok(!r.codes.includes("tax_type_conflict"));
  // no split of the single 180 line tax can give IGST 180 AND CGST/SGST 90 + 90, so it is flagged for what it is
  assert.ok(r.codes.includes("mixed_tax_unreconciled"));
});

test("low confidence and unreadable item values are flagged", () => {
  const r = run(model({ buyer_name: f("Beta", 0.4), line_items: [item({ hsn_sac: unreadable(), description: f("Widget", 0.3) })] }));
  assert.ok(r.flags.some((x) => x.code === "low_confidence" && x.field === "buyer_name"));
  assert.ok(r.codes.includes("unreadable_item_field"));
  assert.ok(r.codes.includes("low_confidence_item"));
});

test("out-of-range amounts and invalid HSN are not saved", () => {
  const r = run(model({ grand_total: f(5e12), line_items: [item({ hsn_sac: f("12") })] }));
  assert.equal(r.extracted.total_amount, null);
  assert.equal(r.extracted.field_status.grand_total.state, "invalid");
  assert.ok(r.codes.includes("amount_out_of_range"));
  assert.equal(r.items[0].hsn_code, null);
  assert.ok(r.codes.includes("invalid_hsn"));
});

test("negative amounts and extra precision are flagged", () => {
  assert.ok(run(model({ discount_total: f(-5) })).codes.includes("negative_amount"));
  assert.ok(run(model({ cess: f(1.2345) })).codes.includes("amount_precision"));
  const unitPrice = run(model({ line_items: [item({ unit_price: f(500.1234), quantity: f(2), taxable_value: f(1000.25) })] }));
  assert.ok(!unitPrice.flags.some((x) => x.code === "amount_precision" && x.field === "unit_price"));
});

test("not_an_invoice produces an error flag", () => {
  assert.ok(run(model({ document_type: "not_an_invoice" })).codes.includes("not_an_invoice"));
});

test("item positions are 1-based and raw output is preserved", () => {
  const m = model({ line_items: [item(), item({ description: f("Gadget") })] });
  const { extracted, items } = normalizeExtraction(m, { model: "test", now: NOW });
  assert.equal(items.length, 2);
  assert.equal(items[1].description, "Gadget");
  assert.equal(extracted.raw_extraction.line_items.length, 2);
  assert.equal(extracted.confidence, 0.95);
});
