// POST /api/exports/tally (experimental, on by default): switch, guards, firm scoping, skip reasons. Fakes only.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";

setup();
const route = await import("../app/api/exports/tally/route.ts");
const inv = (n, firm = F1, over = {}) => ({
  id: uuid(n), firm_id: firm, original_filename: `i${n}.pdf`, status: "verified", created_at: "2026-10-11T04:30:00+00:00", vendor_name: `Supplier ${n}`, vendor_gstin: "27AAPFU0939F1ZV",
  buyer_name: "Beta", buyer_gstin: null, invoice_number: `INV-${n}`, invoice_date: "2026-09-15", place_of_supply: null, currency: "INR", document_type: "tax_invoice",
  taxable_amount: 1000, discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180, confidence: 0.9, review_flags: [], verified_at: "2026-10-11T05:00:00+00:00", ...over,
});
const tables = () => ({ invoice_review_list: [inv(1), inv(2, F1, { status: "needs_review" }), inv(9, F2)] });
const post = (body, o) => route.POST(req("/api/exports/tally", { body, ...o }));
const on = (fn) => fn; // the Tally export is on unless TALLY_EXPORT_ENABLED=false

test("tally: on by default; the route disappears (404) only when TALLY_EXPORT_ENABLED=false", async () => {
  world({ tables: tables() });
  delete process.env.TALLY_EXPORT_ENABLED;
  assert.equal((await post({ format: "xml", invoiceIds: [uuid(1)] })).status, 200);
  process.env.TALLY_EXPORT_ENABLED = "false";
  try { assert.equal((await post({ format: "xml", invoiceIds: [uuid(1)] })).status, 404); } finally { delete process.env.TALLY_EXPORT_ENABLED; }
});

test("tally: other-site, signed-out and invalid requests are refused", on(async () => {
  world({ tables: tables() });
  assert.equal((await post({ format: "xml", invoiceIds: [uuid(1)] }, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post({ format: "xml", invoiceIds: [uuid(1)] }, { origin: null })).status, 403);
  world({ user: null }); assert.equal((await post({ format: "xml", invoiceIds: [uuid(1)] })).status, 401);
  world({ tables: tables() });
  for (const bad of [{}, { format: "pdf", invoiceIds: [uuid(1)] }, { format: "xml" }, { format: "xml", invoiceIds: [] }, { format: "xml", invoiceIds: ["x"] },
    { format: "xml", invoiceIds: [uuid(1)], config: { purchaseLedger: "<script>" } }, { format: "xml", invoiceIds: Array.from({ length: 501 }, (_, i) => uuid(1000 + i)) }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 50));
  }
  assert.equal((await post("{oops")).status, 400);
}));

test("tally: exports verified invoices of the signed-in firm only; others are reported, not exported", on(async () => {
  const h = world({ tables: tables() });
  const res = await readJson(await post({ format: "xml", invoiceIds: [uuid(1), uuid(2), uuid(9), uuid(77)] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.match(res.body.fileName, /^ai-asis-tally-\d{8}-\d{6}\.xml$/);
  assert.match(res.body.contentType, /xml/);
  assert.match(res.body.content, /INV-1/);
  assert.ok(!res.body.content.includes("INV-9") && !res.body.content.includes("Supplier 9"), "no other firm's data");
  const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.invoiceId, s.reason]));
  assert.match(reasons[uuid(2)], /Not verified/);
  assert.equal(reasons[uuid(9)], "Not found.", "another firm's id looks like an unknown id");
  assert.equal(reasons[uuid(77)], "Not found.");
  for (const q of h.db.log.filter((x) => x.table === "invoice_review_list")) assert.ok(q.filters.some(([op, c, v]) => op === "eq" && c === "firm_id" && v === F1));
  assert.equal(h.adminDb.rpcLog.length, 0, "nothing is written (not recorded in export history yet)");
}));

test("tally: JSON and CSV formats; nothing exportable is a 422 with the reasons", on(async () => {
  world({ tables: tables() });
  const j = await readJson(await post({ format: "json", invoiceIds: [uuid(1)] }));
  assert.equal(JSON.parse(j.body.content).status, "experimental-unverified");
  const c = await readJson(await post({ format: "csv", invoiceIds: [uuid(1)] }));
  assert.match(c.body.content, /Voucher No/);
  assert.match(c.body.fileName, /\.csv$/);
  const none = await readJson(await post({ format: "xml", invoiceIds: [uuid(2)] }));
  assert.equal(none.status, 422);
  assert.ok(none.body.skipped.length === 1 && /Not verified/.test(none.body.skipped[0].reason));
}));

test("tally: a database error is a generic 500", on(async () => {
  const h = world({ tables: tables() });
  h.db.errors.invoice_review_list = { code: "XX000", message: "host=10.0.0.9" };
  const res = await readJson(await post({ format: "xml", invoiceIds: [uuid(1)] }));
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes("10.0.0.9"));
}));
