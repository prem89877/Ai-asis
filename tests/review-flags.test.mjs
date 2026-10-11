import test from "node:test";
import assert from "node:assert/strict";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { gstChecks, stateCodeFromPlace, stateCodeFromGstin } from "../lib/review/gst.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { parseListQuery, sanitizeSearch } from "../lib/review/query.ts";
import { reviewState } from "../lib/review/status.ts";

const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const v = (confidence = 1) => ({ state: "value", confidence });
const FS = Object.fromEntries(["supplier_name", "supplier_gstin", "buyer_name", "invoice_number", "invoice_date", "taxable_value", "grand_total", "cgst", "sgst"].map((k) => [k, v()]));

function header(over = {}) {
  const h = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null]));
  return {
    ...h, vendor_name: "Acme", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", invoice_number: "INV-1", invoice_date: "2026-09-15",
    place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000, cgst_amount: 90, sgst_amount: 90, total_amount: 1180, ...over,
  };
}
const item = (o = {}) => ({ description: "W", hsn_code: "8471", quantity: 2, unit: "Nos", unit_price: 500, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180, field_status: {}, ...o });
const codes = (flags) => flags.map((f) => f.code);

test("state helpers", () => {
  assert.equal(stateCodeFromGstin("27AAPFU0939F1ZV"), "27");
  assert.equal(stateCodeFromGstin("99AAPFU0939F1ZV"), "99");
  assert.equal(stateCodeFromGstin(null), null);
  assert.equal(stateCodeFromPlace("Maharashtra (27)"), "27");
  assert.equal(stateCodeFromPlace("29-Karnataka"), "29");
  assert.equal(stateCodeFromPlace("Tamil Nadu"), "33");
  assert.equal(stateCodeFromPlace("Andhra Pradesh"), "28"); // ambiguous names resolve to a code; an explicit code wins when printed
  assert.equal(stateCodeFromPlace("37 - Andhra Pradesh"), "37");
  assert.equal(stateCodeFromPlace("Pondicherry"), "34");
  assert.equal(stateCodeFromPlace("somewhere"), null);
  assert.equal(stateCodeFromPlace(null), null);
});

test("a clean intra-state invoice has no flags", () => {
  assert.deepEqual(computeReviewFlags(header(), FS, [item()], OPTS, new Date("2026-10-11")), []);
});

test("IGST on a same-state supply is flagged, values untouched", () => {
  const h = header({ cgst_amount: null, sgst_amount: null, igst_amount: 180 });
  const flags = computeReviewFlags(h, FS, [item()], OPTS, new Date("2026-10-11"));
  assert.ok(codes(flags).includes("gst_type_mismatch"));
  assert.equal(h.igst_amount, 180);
});

test("CGST+SGST on an inter-state supply is flagged; IGST there is fine", () => {
  const inter = header({ place_of_supply: "Karnataka (29)" });
  assert.ok(codes(computeReviewFlags(inter, FS, [item()], OPTS)).includes("gst_type_mismatch"));
  const ok = header({ place_of_supply: "Karnataka (29)", cgst_amount: null, sgst_amount: null, igst_amount: 180 });
  assert.ok(!codes(computeReviewFlags(ok, FS, [item()], OPTS)).includes("gst_type_mismatch"));
});

test("export / other territory supplies are not forced into intra/inter rules", () => {
  const h = header({ place_of_supply: "Foreign country (96)", cgst_amount: null, sgst_amount: null, igst_amount: 0, total_amount: 1000 });
  const flags = computeReviewFlags(h, FS, [item({ gst_rate: 0, gst_amount: 0, line_total: 1000 })], OPTS);
  assert.ok(!codes(flags).includes("gst_type_mismatch"));
  assert.ok(!codes(flags).includes("supply_type_unknown"));
});

test("unknown place of supply with tax -> info only", () => {
  const flags = computeReviewFlags(header({ place_of_supply: null }), FS, [item()], OPTS);
  const f = flags.find((x) => x.code === "supply_type_unknown");
  assert.ok(f);
  assert.equal(f.severity, "info");
});

test("CGST and SGST that differ are flagged", () => {
  const flags = computeReviewFlags(header({ sgst_amount: 80, total_amount: 1170 }), FS, [item()], OPTS);
  assert.ok(codes(flags).includes("cgst_sgst_unequal"));
});

test("tax without supplier GSTIN, tax on bill of supply", () => {
  assert.ok(codes(computeReviewFlags(header({ vendor_gstin: null }), { ...FS, supplier_gstin: { state: "missing", confidence: 1 } }, [item()], OPTS)).includes("tax_without_gstin"));
  assert.ok(codes(computeReviewFlags(header({ document_type: "bill_of_supply" }), FS, [item()], OPTS)).includes("tax_on_bill_of_supply"));
});

test("bill of supply with no tax and a supplier GSTIN is quiet", () => {
  const h = header({ document_type: "bill_of_supply", cgst_amount: null, sgst_amount: null, total_amount: 1000, place_of_supply: null });
  const flags = computeReviewFlags(h, FS, [item({ gst_rate: null, gst_amount: null, line_total: 1000 })], OPTS);
  assert.deepEqual(codes(flags).filter((c) => !["missing_field"].includes(c)), []);
});

test("tax invoice with no tax gets an info note, not an error", () => {
  const h = header({ cgst_amount: null, sgst_amount: null, total_amount: 1000 });
  const f = computeReviewFlags(h, FS, [item({ gst_rate: null, gst_amount: null, line_total: 1000 })], OPTS).find((x) => x.code === "no_tax_charged");
  assert.ok(f);
  assert.equal(f.severity, "info");
});

test("item tax vs rate and invoice tax vs item rates", () => {
  const flags = computeReviewFlags(header(), FS, [item({ gst_amount: 150 })], OPTS);
  assert.ok(codes(flags).includes("item_tax_rate_mismatch"));
  const h = header({ cgst_amount: 50, sgst_amount: 50, total_amount: 1100 });
  assert.ok(codes(computeReviewFlags(h, FS, [item()], OPTS)).includes("invoice_tax_rate_mismatch"));
});

test("rounding within tolerance does not flag", () => {
  const flags = gstChecks({ ...header(), cgst_amount: 90.4, sgst_amount: 90.4, igst_amount: null, cess_amount: null, vendor_gstin: "27AAPFU0939F1ZV", document_type: "tax_invoice" }, [item({ gst_amount: 180.8 })], { tolerancePaise: 100 });
  assert.ok(!codes(flags).includes("item_tax_rate_mismatch"));
});

test("unusual rate is info; effective rate without item rates is info", () => {
  const f = computeReviewFlags(header(), FS, [item({ gst_rate: 17, gst_amount: 170 })], OPTS).find((x) => x.code === "unusual_gst_rate");
  assert.equal(f.severity, "info");
  const h = header({ cgst_amount: 70, sgst_amount: 70, total_amount: 1140 });
  const e = computeReviewFlags(h, FS, [item({ gst_rate: null, gst_amount: null })], OPTS).find((x) => x.code === "effective_rate_unusual");
  assert.ok(e);
});

test("invalid GSTIN check digit, future date", () => {
  const flags = computeReviewFlags(header({ vendor_gstin: "27AAPFU0939F1ZX", invoice_date: "2027-01-01" }), FS, [item()], OPTS, new Date("2026-10-11"));
  assert.ok(codes(flags).includes("invalid_gstin"));
  assert.ok(codes(flags).includes("implausible_date"));
});

test("missing invoice number and missing GSTIN are raised from field status", () => {
  const fs = { ...FS, invoice_number: { state: "missing", confidence: 1 }, supplier_gstin: { state: "missing", confidence: 1 } };
  const flags = computeReviewFlags(header({ invoice_number: null, vendor_gstin: null }), fs, [item()], OPTS);
  assert.ok(flags.some((f) => f.code === "missing_required" && f.field === "invoice_number" && f.severity === "error"));
  assert.ok(flags.some((f) => f.code === "missing_field" && f.field === "supplier_gstin"));
});

test("credit notes may carry negative amounts; others get a warning", () => {
  const neg = header({ taxable_amount: -1000, cgst_amount: -90, sgst_amount: -90, total_amount: -1180 });
  const items = [item({ taxable_amount: -1000, gst_amount: -180, line_total: -1180, quantity: -2 })];
  assert.ok(!codes(computeReviewFlags({ ...neg, document_type: "credit_note" }, FS, items, OPTS)).includes("negative_amount"));
  assert.ok(codes(computeReviewFlags(neg, FS, items, OPTS)).includes("negative_amount"));
});

test("total mismatch is flagged", () => {
  assert.ok(codes(computeReviewFlags(header({ total_amount: 1500 }), FS, [item()], OPTS)).includes("arithmetic_total_mismatch"));
});

test("list query is whitelisted and sanitized", () => {
  const q = parseListQuery(new URLSearchParams({ q: "ac,me%_(x)*", status: "bogus", sort: "firm_id; drop table", dir: "up", page: "-3", pageSize: "9999", from: "2026-13-01", warning: "duplicate" }));
  assert.equal(q.q, "ac me x");
  assert.equal(q.status, null);
  assert.equal(q.sort, "created_at");
  assert.equal(q.dir, "desc");
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, 100);
  assert.equal(q.from, null);
  assert.equal(q.warning, "duplicate");
  assert.equal(sanitizeSearch("a".repeat(200)).length, 80);
});

test("review states", () => {
  assert.equal(reviewState("uploaded"), "processing");
  assert.equal(reviewState("queued"), "processing");
  assert.equal(reviewState("completed"), "needs_review");
  assert.equal(reviewState("needs_review"), "needs_review");
  assert.equal(reviewState("verified"), "verified");
  assert.equal(reviewState("failed"), "failed");
});
