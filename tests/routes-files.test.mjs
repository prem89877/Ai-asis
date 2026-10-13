// Private file access: the original-file preview and the signed-URL download routes.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";

setup();
const fileRoute = await import("../app/api/invoices/[id]/file/route.ts");
const dlRoute = await import("../app/api/invoices/[id]/download/route.ts");

const pathOf = (firm, n) => `${firm}/${uuid(n)}.pdf`;
const row = (n, firm, status = "completed") => ({ id: uuid(n), firm_id: firm, storage_path: pathOf(firm, n), mime_type: "application/pdf", original_filename: `inv ${n}.pdf`, status });
const objects = { [pathOf(F1, 1)]: "%PDF-own", [pathOf(F1, 2)]: "%PDF-deleting", [pathOf(F2, 9)]: "%PDF-foreign" };
const tables = () => ({ invoices: [row(1, F1), row(2, F1, "pending_deletion"), row(9, F2), row(3, F1)] });
const get = (route, id) => route.GET(req(`/api/invoices/${id}/x`, { method: "GET", origin: null }), { params: { id } });

for (const [name, route] of [["file", fileRoute], ["download", dlRoute]]) {
  test(`${name}: signed-out users get 401 and a malformed id never reaches the database`, async () => {
    const h = world({ user: null, tables: tables(), objects });
    assert.equal((await get(route, uuid(1))).status, 401);
    assert.equal((await get(route, "../../etc/passwd")).status, 404);
    assert.equal(h.db.log.filter((q) => q.table === "invoices").length, 0);
  });
  test(`${name}: another firm's invoice, a deleting invoice and a missing object all look like 'not found'`, async () => {
    world({ tables: tables(), objects });
    assert.equal((await get(route, uuid(9))).status, 404, "foreign firm");
    assert.equal((await get(route, uuid(2))).status, 404, "pending deletion");
    assert.equal((await get(route, uuid(3))).status, 404, "row exists but the file is gone");
    assert.equal((await get(route, uuid(77))).status, 404, "unknown id");
  });
  test(`${name}: the invoice query carries the firm_id filter`, async () => {
    const h = world({ tables: tables(), objects });
    await get(route, uuid(1));
    const q = h.db.log.find((x) => x.table === "invoices");
    assert.ok(q.filters.some(([op, c, v]) => op === "eq" && c === "firm_id" && v === F1));
  });
}

test("file: own invoice is served with private, non-sniffable, same-origin-framable headers", async () => {
  world({ tables: tables(), objects });
  const res = await get(fileRoute, uuid(1));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(res.headers.get("content-disposition"), /^inline; filename="inv_1\.pdf"$/);
  assert.equal(await res.text(), "%PDF-own");
});

test("file: a stored mime type outside the allowed list is served as octet-stream, never as html", async () => {
  const t = tables(); t.invoices[0].mime_type = "text/html";
  world({ tables: t, objects });
  assert.equal((await get(fileRoute, uuid(1))).headers.get("content-type"), "application/octet-stream");
});

test("download: returns a signed URL that lasts 60 seconds and is not cached", async () => {
  const h = world({ tables: tables(), objects });
  const res = await get(dlRoute, uuid(1));
  const out = await readJson(res);
  assert.equal(out.status, 200);
  assert.match(out.body.url, /^https:\/\/storage\.test\/invoices\//);
  assert.equal(h.client.storage.signed[0].ttl, 60);
  assert.equal(h.client.storage.signed[0].bucket, "invoices");
  assert.equal(res.headers.get("cache-control"), "no-store");
});
