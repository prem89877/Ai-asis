// Part 2: commercial-discount invoice ("Domestic Tax Invoice with CGST SGST and Cess").
// The figures below are TEST DATA from the supplied invoice; production code never contains them.
//   taxable 400,000 | CGST 51,500 | SGST 51,500 | cess 44,700 | subtotal 547,700 | commercial discount 2,700 | net payable 545,000 | no TCS / TDS
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { checkHeaderDraft } from "../lib/review/draft-check.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { buildTables } from "../lib/export/build.ts";
import { INVOICE_COLUMNS } from "../lib/export/columns.ts";
import { readFileSync } from "node:fs";
import { f, missing, item, model } from "./helpers.mjs";

const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-15") });
const B = (over = {}) => model({
  taxable_value: f(400000), cgst: f(51500), sgst: f(51500), igst: missing(), cess: f(44700),
  grand_total: f(547700), discount_total: f(2700), net_payable_amount: f(545000), tcs_amount: f(0), tds_amount: f(0),
  line_items: [item({ description: f("Line"), quantity: f(1), unit_price: f(400000), taxable_value: f(400000), gst_rate: f(25.75), tax_amount: f(103000), line_total: f(547700), applied_tax_type: f("CGST+SGST") })],
  ...over,
});

const base = () => {
  const b = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, ""]));
  return Object.assign(b, { currency: "INR", taxable_amount: "400000", discount_amount: "2700", cgst_amount: "51500", sgst_amount: "51500", cess_amount: "44700", total_amount: "545000" });
};

test("review screen: editing a field of invoice B does not report the discount as a total mismatch", () => {
  const b = base();
  assert.deepEqual(checkHeaderDraft({ ...b, cess_amount: "44700.00" }, b, new Date("2026-10-15")), {});
  assert.deepEqual(checkHeaderDraft({ ...b, total_amount: "547700" }, b, new Date("2026-10-15")), {}, "the subtotal 547,700 is also valid");
});

test("review screen: a total the discount does not explain is still warned about", () => {
  const b = base();
  const issues = checkHeaderDraft({ ...b, total_amount: "540000" }, b, new Date("2026-10-15"));
  assert.equal(issues.total_amount?.[0].severity, "warning");
  assert.match(issues.total_amount[0].message, /after the discount/);
});

test("review screen: without a discount the old check is unchanged", () => {
  const b = { ...base(), discount_amount: "" };
  const issues = checkHeaderDraft({ ...b, cess_amount: "44700.5" }, b, new Date("2026-10-15"));
  assert.equal(issues.total_amount?.[0].severity, "warning");
  const noDisc = checkHeaderDraft({ ...b, total_amount: "547700" }, { ...b, total_amount: "1" }, new Date("2026-10-15"));
  assert.deepEqual(noDisc, {});
});

test("engine: invoice B reconciles with no TCS / TDS invented, and a TCS typed by a reviewer is still added", () => {
  const r = validateInvoice(norm(B()), { tolerancePaise: 100 });
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.expected_grand_total, 547700);
  assert.deepEqual([r.summary.adjustments.tcs, r.summary.adjustments.tds, r.summary.adjustments.tcs_tds_applied], [0, 0, false]);
  const withTcs = validateInvoice(norm(B({ tcs_amount: f(5000) })), { tolerancePaise: 100 });
  assert.ok(withTcs.flags.some((x) => x.code === "arithmetic_total_mismatch"), "a TCS that is not in the total is not absorbed silently");
});

test("engine: a wrong tax breakdown on invoice B cannot hide behind a matching total", () => {
  const r = validateInvoice(norm(B({ cgst: f(60000), sgst: f(43000) })), { tolerancePaise: 100 });
  assert.ok(r.flags.some((x) => x.severity !== "info"), "CGST 60,000 / SGST 43,000 keeps the same total but must be flagged");
  assert.notEqual(r.summary.verification.level, "verified");
});

test("review re-check after a save keeps the net payable and raises nothing for invoice B", () => {
  const e = norm(B()).extracted;
  const h = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, e[c] ?? null]));
  const flags = computeReviewFlags(h, {}, norm(B()).items, { lowConfidence: 0.8, tolerancePaise: 100 }, new Date("2026-10-15"),
    { tcs_amount: e.tcs_amount, tds_amount: e.tds_amount, net_payable_amount: e.net_payable_amount, round_off_amount: e.round_off_amount });
  assert.deepEqual(flags.filter((x) => x.severity !== "info").map((x) => x.code), []);
});

test("exports: discount, TCS, TDS, round-off and net payable are exportable and keep their printed values", () => {
  const inv = {
    id: "i1", original_filename: "b.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00", vendor_name: "Acme", vendor_gstin: null, buyer_name: "Beta", buyer_gstin: null,
    invoice_number: "B-1", invoice_date: "2026-10-01", place_of_supply: null, currency: "INR", document_type: "tax_invoice", taxable_amount: 400000, discount_amount: 2700,
    cgst_amount: 51500, sgst_amount: 51500, igst_amount: null, cess_amount: 44700, tax_total: 147700, total_amount: 547700, tcs_amount: null, tds_amount: 0, round_off_amount: null,
    net_payable_amount: 545000, confidence: 1, review_flags: [], verified_at: null,
  };
  const keys = ["discount_amount", "total_amount", "tcs_amount", "tds_amount", "round_off_amount", "net_payable_amount"];
  const [t] = buildTables([inv], new Map(), { format: "csv", columns: keys, itemColumns: [], includeItems: false });
  assert.deepEqual(t.headers, ["Discount", "Invoice Total", "TCS", "TDS", "Round Off", "Net Payable"]);
  assert.deepEqual(t.rows[0], [2700, 547700, null, 0, null, 545000]); // not printed stays empty, a printed 0 stays 0
});

test("the export select list and the column keys stay in step with migration 015", () => {
  const INVOICE_SELECT = /INVOICE_SELECT =\s*"([^"]+)"/.exec(readFileSync(new URL("../lib/export/run.ts", import.meta.url), "utf8"))[1];
  for (const k of ["tcs_amount", "tds_amount", "round_off_amount", "net_payable_amount"]) {
    assert.ok(INVOICE_SELECT.split(", ").includes(k), `${k} selected`);
    assert.ok(INVOICE_COLUMNS.some((c) => c.key === k), `${k} column`);
  }
});
