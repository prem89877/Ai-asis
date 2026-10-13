// Route-level tests for /api/exports (POST, GET) and /api/exports/:id/download.
// No network and no database: the Supabase clients are in-memory fakes (tests/helpers/route-harness.mjs). The fake applies
// the route's own eq/in/gte filters, so a missing firm_id filter would show up as foreign rows in these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";

setup();
const exportsRoute = await import("../app/api/exports/route.ts");
const downloadRoute = await import("../app/api/exports/[id]/download/route.ts");

const inv = (n, firm, status = "verified", over = {}) => ({
  id: uuid(n), firm_id: firm, original_filename: `i${n}.pdf`, status, created_at: "2026-10-11T04:30:00+00:00",
  vendor_name: "Acme Traders", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", buyer_gstin: null, invoice_number: `INV-${n}`,
  invoice_date: "2026-09-15", place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000,
  discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180,
  confidence: 0.9, review_flags: [], verified_at: "2026-10-11T05:00:00+00:00", ...over,
});
const invoices = () => [inv(1, F1), inv(2, F1, "needs_review"), inv(3, F1, "failed"), inv(9, F2)];
const okRpc = { record_export: () => ({ data: uuid(500), error: null }) };
const good = (over = {}) => ({ format: "csv", columns: ["invoice_number", "total_amount"], invoiceIds: [uuid(1)], ...over });
const post = (body, o) => exportsRoute.POST(req("/api/exports", { body, ...o }));

test("export POST: a request from another site (or without Origin) is refused before anything is read", async () => {
  const h = world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  assert.equal((await post(good(), { origin: "https://evil.test" })).status, 403);
  assert.equal((await post(good(), { origin: null })).status, 403);
  assert.equal(h.db.log.length, 0);
  assert.equal(h.adminDb.rpcLog.length, 0);
});

test("export POST: signed-out users get 401, users without a firm get 403", async () => {
  world({ user: null });
  assert.equal((await post(good())).status, 401);
  world({ members: [] });
  assert.equal((await post(good())).status, 403);
});

test("export POST: malformed, oversized and invalid requests are rejected with 4xx", async () => {
  world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post("[1,2]")).status, 400);
  assert.equal((await post("null")).status, 400);
  assert.equal((await post(good(), { headers: { "content-length": String(10 * 1024 * 1024) } })).status, 413);
  assert.equal((await post(good({ format: "pdf" }))).status, 400);
  assert.equal((await post(good({ columns: ["invoice_number", "drop table"] }))).status, 400);
  assert.equal((await post(good({ columns: ["invoice_number", "invoice_number"] }))).status, 400);
  assert.equal((await post(good({ invoiceIds: [] }))).status, 400);
  assert.equal((await post(good({ invoiceIds: ["not-a-uuid"] }))).status, 400);
  assert.equal((await post(good({ invoiceIds: undefined }))).status, 400);
  assert.equal((await post(good({ profile: "tally" }))).status, 400); // Tally is not a normal export profile
  assert.equal((await post(good({ invoiceIds: Array.from({ length: 501 }, (_, i) => uuid(1000 + i)) }))).status, 400);
});

test("export POST: duplicate ids are collapsed, so repeating one id 600 times is not 'too many'", async () => {
  world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  const res = await readJson(await post(good({ invoiceIds: Array(600).fill(uuid(1)) })));
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
});

test("export POST: success is recorded with the firm and user from the SESSION, never from the body", async () => {
  const h = world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  const res = await readJson(await post({ ...good({ invoiceIds: [uuid(1), uuid(2), uuid(9)] }), firmId: F2, firm_id: F2, p_firm_id: F2 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.id, uuid(500));
  assert.equal(res.body.count, 2);
  assert.equal(res.body.skipped, 1, "the other firm's invoice is skipped, not exported");
  assert.equal(res.body.unverified, 1);
  assert.match(res.body.fileName, /^ai-asis-invoices-\d{8}-\d{6}\.csv$/);
  const rec = h.adminDb.rpcLog.find((c) => c.name === "record_export");
  assert.equal(rec.args.p_firm_id, F1);
  assert.equal(rec.args.p_user_id, "u1");
  assert.deepEqual([...rec.args.p_invoice_ids].sort(), [uuid(1), uuid(2)].sort());
  assert.ok(!rec.args.p_invoice_ids.includes(uuid(9)));
  assert.equal(rec.args.p_format, "csv");
});

test("export POST: every query filters by firm_id (explicit filter on top of RLS)", async () => {
  const h = world({ tables: { invoice_review_list: invoices(), line_items: [] }, rpc: okRpc });
  await post(good({ includeItems: true, itemColumns: ["position"], invoiceIds: [uuid(1)] }));
  const tenantReads = h.db.log.filter((q) => ["invoice_review_list", "line_items", "export_history"].includes(q.table));
  assert.ok(tenantReads.length >= 3);
  for (const q of tenantReads) assert.ok(q.filters.some(([op, c, v]) => op === "eq" && c === "firm_id" && v === F1), `${q.table} read lacks firm_id filter`);
});

test("export POST: verifiedOnly exports verified invoices only; none verified is a clear 422", async () => {
  world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  const ok = await readJson(await post(good({ verifiedOnly: true, invoiceIds: [uuid(1), uuid(2)] })));
  assert.equal(ok.body.count, 1);
  assert.equal(ok.body.skipped, 1);
  const none = await readJson(await post(good({ verifiedOnly: true, invoiceIds: [uuid(2)] })));
  assert.equal(none.status, 422);
  assert.match(none.body.error, /verified/);
});

test("export POST: invoices that failed or are not extracted yet are never exported", async () => {
  world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  const res = await readJson(await post(good({ invoiceIds: [uuid(3)] })));
  assert.equal(res.status, 422);
  assert.match(res.body.error, /extracted data/);
});

test("export POST: rate limit is 10 per minute per firm, counted from this firm's recent history only", async () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = (n, firm, at) => Array.from({ length: n }, (_, i) => ({ id: `${firm}-${at}-${i}`, firm_id: firm, created_at: at }));
  // 9 recent for this firm + 50 recent for another firm + 50 old: still allowed
  world({ tables: { invoice_review_list: invoices(), export_history: [...rows(9, F1, recent), ...rows(50, F2, recent), ...rows(50, F1, old)] }, rpc: okRpc });
  assert.equal((await post(good())).status, 200);
  // 10 recent for this firm: blocked, with Retry-After
  const h = world({ tables: { invoice_review_list: invoices(), export_history: rows(10, F1, recent) }, rpc: okRpc });
  const res = await post(good());
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(h.adminDb.rpcLog.length, 0, "nothing is recorded when rate limited");
});

test("export POST: if the rate-limit check itself fails, the export is refused (fail closed) with no technical detail", async () => {
  const h = world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  h.db.errors.export_history = { code: "42P01", message: 'relation "export_history" does not exist', details: "secret detail" };
  const res = await readJson(await post(good()));
  assert.equal(res.status, 500);
  assert.equal(res.body.detail, undefined);
  assert.ok(!JSON.stringify(res.body).includes("secret detail"));
  assert.equal(h.adminDb.rpcLog.length, 0);
});

test("export POST: database failure while reading invoices returns a generic 500 without technical detail", async () => {
  const h = world({ tables: { invoice_review_list: invoices() }, rpc: okRpc });
  h.db.errors.invoice_review_list = { code: "57P01", message: "terminating connection due to administrator command", details: "host=10.0.0.5" };
  const res = await readJson(await post(good()));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "The export could not be created. Try again.");
  assert.equal(res.body.detail, undefined);
  assert.ok(!JSON.stringify(res.body).includes("10.0.0.5"));
});

test("export POST: export history failure returns a generic 500 without detail; missing service key returns 503", async () => {
  world({ tables: { invoice_review_list: invoices() }, rpc: { record_export: () => ({ data: null, error: { code: "23514", message: "check constraint violated" } }) } });
  const res = await readJson(await post(good()));
  assert.equal(res.status, 500);
  assert.equal(res.body.detail, undefined);
  world({ tables: { invoice_review_list: invoices() }, rpc: okRpc, admin: false });
  assert.equal((await post(good())).status, 503);
});

test("export GET: lists only the signed-in firm's history (newest first, max 20) and needs a session", async () => {
  const hist = [
    { id: "a", firm_id: F1, format: "csv", invoice_count: 1, skipped_count: 0, include_items: false, file_name: "a.csv", created_at: "2026-10-01" },
    { id: "b", firm_id: F2, format: "csv", invoice_count: 5, skipped_count: 0, include_items: false, file_name: "b.csv", created_at: "2026-10-02" },
    { id: "c", firm_id: F1, format: "xlsx", invoice_count: 2, skipped_count: 1, include_items: true, file_name: "c.xlsx", created_at: "2026-10-03" },
  ];
  world({ tables: { export_history: hist } });
  const res = await readJson(await exportsRoute.GET(req("/api/exports", { method: "GET", origin: null })));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.exports.map((e) => e.id), ["c", "a"]);
  world({ user: null });
  assert.equal((await exportsRoute.GET(req("/api/exports", { method: "GET", origin: null }))).status, 401);
});

test("export download: another firm's export id looks like 'not found'; a bad id never reaches the database", async () => {
  const foreign = { id: uuid(700), firm_id: F2, format: "csv", column_keys: ["invoice_number"], item_columns: [], include_items: false, verified_only: false, date_format: "iso", invoice_ids: [uuid(9)], file_name: "x.csv" };
  const own = { ...foreign, id: uuid(701), firm_id: F1, invoice_ids: [uuid(1)], file_name: "own.csv" };
  const h = world({ tables: { export_history: [foreign, own], invoice_review_list: invoices() } });
  const get = (id) => downloadRoute.GET(req(`/api/exports/${id}/download`, { method: "GET", origin: null }), { params: { id } });
  assert.equal((await get("../../etc/passwd")).status, 404);
  assert.equal(h.db.log.length, 0);
  assert.equal((await get(uuid(700))).status, 404);
  const res = await get(uuid(701));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="own\.csv"/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const text = new TextDecoder().decode(await res.arrayBuffer());
  assert.match(text, /INV-1/);
  assert.ok(!text.includes("INV-9"));
});
