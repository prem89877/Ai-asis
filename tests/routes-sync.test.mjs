// Route-level tests for POST /api/integrations/connections/:id/sync using MOCKED cloud services.
// The provider modules (lib/integrations/*) are replaced by tests/stubs/integrations/*, so no network, token or crypto
// code runs. These tests prove what the ROUTE does when the (mocked) engine reports a revoked or expired token, a rate
// limit, a timeout, a changed header row or a lost response. They do not prove the real Google / Microsoft behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";

setup({ mockIntegrations: true });
const route = await import("../app/api/integrations/connections/[id]/sync/route.ts");
const { IntegrationError } = await import("./stubs/integrations/http.mjs");

const CONN = uuid(900);
const conn = (over = {}) => ({
  id: CONN, firm_id: F1, provider: "google_sheets", status: "active", date_format: "iso",
  mapping: [{ header: "AI Asis ID", field: "id" }], target: { spreadsheetId: "sheet1", worksheetTitle: "Purchases" }, ...over,
});
const inv = (n, firm = F1, status = "verified", over = {}) => ({ id: uuid(n), firm_id: firm, status, created_at: `2026-10-${String(n % 28 + 1).padStart(2, "0")}`, invoice_number: `INV-${n}`, ...over });
const sr = (invoiceId, status = "synced", over = {}) => ({ id: `sr-${invoiceId}`, firm_id: F1, connection_id: CONN, invoice_id: invoiceId, status, updated_at: "2026-10-01T00:00:00Z", ...over });

function setupWorld(over = {}) {
  const h = world({
    tables: { integration_connections: [conn(), conn({ id: uuid(901), firm_id: F2 })], invoice_review_list: [inv(1), inv(2), inv(3), inv(4, F1, "needs_review"), inv(9, F2)], sync_records: [], ...(over.tables ?? {}) },
    ...(over.world ?? {}),
  });
  h.integ.sync = async ({ invoices }) => invoices.map((i) => ({ invoiceId: i.id, status: "synced" }));
  return h;
}
const post = (body = {}, o = {}) => route.POST(req(`/api/integrations/connections/${o.id ?? CONN}/sync`, { body, ...o }), { params: { id: o.id ?? CONN } });
const sentIds = (h) => h.integ.syncArgs.invoices.map((i) => i.id).sort();
const calls = (h, name) => h.integ.calls.filter((c) => c[0] === name);

test("sync: a request from another site is refused and no provider is contacted", async () => {
  const h = setupWorld();
  assert.equal((await post({}, { origin: "https://evil.test" })).status, 403);
  assert.equal((await post({}, { origin: null })).status, 403);
  assert.equal(h.integ.syncArgs, undefined);
  assert.equal(calls(h, "getAccessToken").length, 0);
});

test("sync: signed-out 401; plain members 403; another firm's connection id is 404", async () => {
  setupWorld({ world: { user: null } });
  assert.equal((await post()).status, 401);
  setupWorld({ world: { role: "member" } });
  assert.equal((await post()).status, 403);
  const h = setupWorld();
  assert.equal((await post({}, { id: uuid(901) })).status, 404);
  assert.equal(h.integ.syncArgs, undefined);
});

test("sync: a connection that needs re-authorisation is not used (409 auth_expired), no token is requested", async () => {
  const h = setupWorld({ tables: { integration_connections: [conn({ status: "needs_reauth" })] } });
  const res = await readJson(await post());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "auth_expired");
  assert.equal(calls(h, "getAccessToken").length, 0);
});

test("sync: no file chosen or no column mapping yet is a clear 409 (Google and Excel)", async () => {
  for (const c of [conn({ target: {} }), conn({ mapping: [] }), conn({ provider: "microsoft_excel", target: { itemId: "x" } })]) {
    const h = setupWorld({ tables: { integration_connections: [c] } });
    const res = await readJson(await post());
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Choose a file and map the columns/);
    assert.equal(calls(h, "getAccessToken").length, 0);
  }
});

test("sync: more than 100 invoice rows touched by this firm in a minute is a 429 with Retry-After", async () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const rows = (n, firm) => Array.from({ length: n }, (_, i) => ({ id: `${firm}${i}`, firm_id: firm, connection_id: CONN, invoice_id: uuid(5000 + i), status: "synced", updated_at: recent }));
  let h = setupWorld({ tables: { sync_records: [...rows(99, F1), ...rows(500, F2)] } }); // other firms do not count
  assert.equal((await post()).status, 200);
  h = setupWorld({ tables: { sync_records: rows(100, F1) } });
  const res = await post();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(calls(h, "getAccessToken").length, 0);
});

test("sync: invoiceIds must be 1 to 25 unique valid UUIDs", async () => {
  setupWorld();
  for (const bad of [[], "abc", {}, ["x"], [uuid(1), 5], Array.from({ length: 26 }, (_, i) => uuid(100 + i))]) {
    assert.equal((await post({ invoiceIds: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await post("{oops")).status, 400);
});

test("sync: without ids, the oldest VERIFIED invoices of this firm that are not synced yet are sent (max 25)", async () => {
  const h = setupWorld({ tables: { sync_records: [sr(uuid(1))] } });
  const res = await readJson(await post());
  assert.equal(res.status, 200);
  assert.deepEqual(sentIds(h), [uuid(2), uuid(3)].sort(), "invoice 1 is already synced, 4 is not verified, 9 belongs to another firm");
  assert.equal(res.body.summary.synced, 2);
  const many = Array.from({ length: 40 }, (_, i) => inv(100 + i));
  const h2 = setupWorld({ tables: { invoice_review_list: many } });
  await post();
  assert.equal(h2.integ.syncArgs.invoices.length, 25);
});

test("sync: when everything verified is already in the sheet, nothing is sent", async () => {
  const h = setupWorld({ tables: { sync_records: [sr(uuid(1)), sr(uuid(2)), sr(uuid(3))] } });
  const res = await readJson(await post());
  assert.equal(res.status, 200);
  assert.match(res.body.message, /Nothing to sync/);
  assert.equal(h.integ.syncArgs, undefined);
  assert.equal(calls(h, "getAccessToken").length, 0);
});

test("sync: another firm's invoice id sent by hand is never passed to the engine", async () => {
  const h = setupWorld();
  await post({ invoiceIds: [uuid(1), uuid(9)] });
  assert.deepEqual(sentIds(h), [uuid(1)]);
  for (const q of h.db.log.filter((x) => ["invoice_review_list", "sync_records", "integration_connections"].includes(x.table))) {
    assert.ok(q.filters.some(([op, c, v]) => op === "eq" && c === "firm_id" && v === F1), `${q.table} read lacks firm_id filter`);
  }
});

test("sync: revoked or expired refresh token while getting an access token marks the connection for reconnect and writes nothing", async () => {
  const h = setupWorld();
  h.integ.tokenError = new IntegrationError("auth_expired", 400);
  const res = await readJson(await post());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "auth_expired");
  assert.equal(calls(h, "markNeedsReauth").length, 1);
  assert.equal(calls(h, "recordConnectionError").length, 0);
  assert.equal(h.integ.syncArgs, undefined);
});

test("sync: the engine reporting a 401 on every row also moves the connection to 'reconnect'", async () => {
  const h = setupWorld();
  h.integ.sync = async ({ invoices }) => { h.integ.onFail("auth_expired", "Your connection has expired. Reconnect your account."); return invoices.map((i) => ({ invoiceId: i.id, status: "failed", code: "auth_expired" })); };
  const res = await readJson(await post());
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.failed, 3);
  assert.equal(calls(h, "markNeedsReauth").length, 1);
  assert.equal(calls(h, "recordConnectionError").length, 0);
});

test("sync: provider rate limit (429) is reported with Retry-After and stored as a connection error, not as a revoked token", async () => {
  const h = setupWorld();
  h.integ.sync = async () => { throw new IntegrationError("rate_limited", 429); };
  const res = await post();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal(calls(h, "recordConnectionError").length, 1);
  assert.equal(calls(h, "markNeedsReauth").length, 0);
});

test("sync: provider timeout gives a 504 with a safe message, and the failure is recorded", async () => {
  const h = setupWorld();
  h.integ.sync = async () => { throw new IntegrationError("timeout", 0, "AbortError: connect ETIMEDOUT 10.1.2.3:443"); };
  const res = await readJson(await post());
  assert.equal(res.status, 504);
  assert.ok(!JSON.stringify(res.body).includes("10.1.2.3"), "internal error text must not reach the browser");
  assert.equal(calls(h, "recordConnectionError").length, 1);
});

test("sync: an unexpected exception returns a generic message and never its text", async () => {
  const h = setupWorld();
  h.integ.sync = async () => { throw new Error("password=hunter2 at db.internal:5432"); };
  const res = await readJson(await post());
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes("hunter2"));
  assert.ok(!JSON.stringify(h.integ.calls).includes("hunter2"), "the stored last_error must not contain internal text either");
});

test("sync: a changed header row fails the rows, records the reason on the connection and does NOT ask for reconnect", async () => {
  const h = setupWorld();
  const msg = "The header row of the sheet changed. Restore it or map the columns again.";
  h.integ.sync = async ({ invoices }) => { h.integ.onFail("header_changed", msg); return invoices.map((i) => ({ invoiceId: i.id, status: "failed", code: "header_changed", message: msg })); };
  const res = await readJson(await post());
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.failed, 3);
  assert.equal(res.body.summary.synced, 0);
  assert.deepEqual(calls(h, "recordConnectionError")[0].slice(2), [msg]);
  assert.equal(calls(h, "markNeedsReauth").length, 0);
});

test("sync: lost response recovery (row already in the sheet) counts as synced and is not an error", async () => {
  const h = setupWorld();
  h.integ.sync = async ({ invoices }) => invoices.map((i, n) => ({ invoiceId: i.id, status: n === 0 ? "recovered" : n === 1 ? "already_synced" : "duplicate" }));
  const res = await readJson(await post());
  assert.deepEqual(res.body.summary, { total: 3, synced: 1, already: 1, duplicates: 1, notVerified: 0, inProgress: 0, failed: 0 });
  assert.equal(calls(h, "recordConnectionError").length, 0);
  assert.equal(calls(h, "markNeedsReauth").length, 0);
});

test("sync: Excel connections get the Microsoft driver, Google connections the Google driver; the token is passed to the driver, not returned", async () => {
  let h = setupWorld();
  await post();
  assert.equal(h.integ.syncArgs.driver.kind, "google");
  h = setupWorld({ tables: { integration_connections: [conn({ provider: "microsoft_excel", target: { itemId: "item", worksheetId: "ws", tableId: "t1" } })] } });
  const res = await readJson(await post());
  assert.equal(h.integ.syncArgs.driver.kind, "microsoft");
  assert.deepEqual(h.integ.syncArgs.driver.target, { itemId: "item", worksheetId: "ws", tableId: "t1" });
  assert.ok(!JSON.stringify(res.body).includes("mock-access-token"));
});
