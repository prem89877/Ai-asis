// Malformed and abusive uploads, duplicate files, storage/database failures, and the deletion workflow (route level, fakes only).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";
import { minimalPdf, png, jpeg } from "./helpers.mjs";

setup();
const upload = await import("../app/api/invoices/upload/route.ts");
const del = await import("../app/api/invoices/[id]/route.ts");

const form = (bytes, name = "bill.pdf", extra = {}) => {
  const fd = new FormData();
  if (bytes !== null) fd.set("file", new File([bytes], name));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
};
const send = (fd, o = {}) => upload.POST(req("/api/invoices/upload", { body: fd, ...o }));

test("upload: other-site, signed-out and firm-less requests are refused before the body is read", async () => {
  const h = world();
  assert.equal((await send(form(minimalPdf()), { origin: "https://evil.test" })).status, 403);
  assert.equal((await send(form(minimalPdf()), { origin: null })).status, 403);
  world({ user: null });
  assert.equal((await send(form(minimalPdf()))).status, 401);
  world({ members: [] });
  assert.equal((await send(form(minimalPdf()))).status, 403);
  assert.equal(h.client.storage.uploaded.length, 0);
});

test("upload: malformed bodies (not multipart, no file, text field instead of file) are 400 and store nothing", async () => {
  const h = world();
  assert.equal((await upload.POST(req("/api/invoices/upload", { body: "{}" }))).status, 400);
  assert.equal((await send(form(null))).status, 400);
  const fd = new FormData(); fd.set("file", "just text");
  assert.equal((await send(fd)).status, 400);
  assert.equal(h.client.storage.uploaded.length, 0);
  assert.equal(h.db.writes.length, 0);
});

test("upload: oversized files are 413 (declared length and real size); empty file 400", async () => {
  const h = world();
  assert.equal((await upload.POST(req("/api/invoices/upload", { body: form(minimalPdf()), headers: { "content-length": String(50 * 1024 * 1024) } }))).status, 413);
  const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal((await send(form(big))).status, 413);
  assert.equal((await send(form(new Uint8Array(0)))).status, 400);
  assert.equal(h.client.storage.uploaded.length, 0);
});

test("upload: scripts, executables, SVG/HTML and renamed files are rejected by content, whatever the name says", async () => {
  const h = world();
  const enc = (s) => new TextEncoder().encode(s);
  const bad = [
    ["invoice.pdf", enc("<html><script>alert(1)</script></html>")],
    ["invoice.pdf", enc('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
    ["invoice.png", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])], // Windows executable
    ["invoice.jpg", enc("#!/bin/sh\nrm -rf /\n")],
    ["invoice.pdf", enc("PK\u0003\u0004 zip bomb")],
    ["invoice.pdf", enc(" %PDF-1.4")], // leading space: not a PDF signature
  ];
  for (const [name, bytes] of bad) {
    const res = await send(form(bytes, name));
    assert.equal(res.status, 415, name);
  }
  assert.equal(h.client.storage.uploaded.length, 0);
  assert.equal(h.db.writes.length, 0);
});

test("upload: batch id must be a UUID and belong to the firm; the daily limit is 429 and counts only this firm", async () => {
  let h = world({ tables: { batches: [{ id: uuid(70), firm_id: F1 }, { id: uuid(71), firm_id: F2 }] } });
  assert.equal((await send(form(minimalPdf(), "a.pdf", { batch_id: "nope" }))).status, 400);
  assert.equal((await send(form(minimalPdf(), "a.pdf", { batch_id: uuid(71) }))).status, 404);
  assert.equal((await send(form(minimalPdf(), "a.pdf", { batch_id: uuid(70) }))).status, 201);
  process.env.EXTRACTION_UPLOADS_PER_DAY = "2";
  try {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const rows = (n, firm) => Array.from({ length: n }, (_, i) => ({ id: `${firm}${i}`, firm_id: firm, created_at: recent }));
    h = world({ tables: { invoices: [...rows(1, F1), ...rows(10, F2)] } });
    assert.equal((await send(form(minimalPdf()))).status, 201);
    h = world({ tables: { invoices: rows(2, F1) } });
    const res = await send(form(minimalPdf()));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "3600");
    assert.equal(h.client.storage.uploaded.length, 0);
  } finally { delete process.env.EXTRACTION_UPLOADS_PER_DAY; }
});

test("upload: success stores under the user's firm folder and saves firm, user, hash and a sanitised name from the SERVER side", async () => {
  const h = world();
  const bytes = minimalPdf(2);
  const res = await readJson(await send(form(bytes, "../../etc/<script>evil</script>.pdf", { firm_id: F2, firmId: F2, status: "verified" })));
  assert.equal(res.status, 201);
  const row = h.db.writes.find((w) => w.table === "invoices" && w.op === "insert").row;
  assert.equal(row.id, res.body.id);
  assert.equal(row.firm_id, F1);
  assert.equal(row.uploaded_by, "u1");
  assert.equal(row.status, "uploaded");
  assert.equal(row.storage_path, `${F1}/${res.body.id}.pdf`);
  assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(row.mime_type, "application/pdf");
  assert.ok(!/[\\/<>]/.test(row.original_filename), row.original_filename);
  assert.equal(h.client.storage.uploaded[0].opts.upsert, false);
  const png1 = await readJson(await send(form(png(), "scan.PNG")));
  const jpg1 = await readJson(await send(form(jpeg(), "photo.jpeg")));
  assert.equal(png1.status, 201); assert.equal(jpg1.status, 201);
  assert.match(h.client.storage.uploaded[1].path, /\.png$/); assert.match(h.client.storage.uploaded[2].path, /\.jpg$/);
});

test("upload: the SAME file twice (unique hash per firm) is a clear 409 and the orphan file is removed", async () => {
  const h = world();
  h.db.ctl.writeErrors["invoices:insert"] = { code: "23505", message: "duplicate key value violates unique constraint invoices_firm_sha256_uidx" };
  const res = await readJson(await send(form(minimalPdf())));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already been uploaded/);
  assert.equal(h.client.storage.removed.length, 1, "no orphan file is left in the bucket");
  assert.equal(h.client.storage.removed[0], h.client.storage.uploaded[0].path);
});

test("upload: full batch is 409; any other database error is a generic 500; both remove the stored file", async () => {
  let h = world();
  h.db.ctl.writeErrors["invoices:insert"] = { code: "23514", message: "new row violates check constraint: batch_full" };
  assert.equal((await send(form(minimalPdf()))).status, 409);
  assert.equal(h.client.storage.removed.length, 1);
  h = world();
  h.db.ctl.writeErrors["invoices:insert"] = { code: "XX000", message: "connection to 10.0.0.9 lost" };
  const res = await readJson(await send(form(minimalPdf())));
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(res.body).includes("10.0.0.9"));
  assert.equal(h.client.storage.removed.length, 1);
});

test("upload: a storage outage is a 502 and no invoice row is created", async () => {
  const h = world();
  h.db.ctl.uploadError = { message: "Bucket unavailable at s3.internal" };
  const res = await readJson(await send(form(minimalPdf())));
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes("s3.internal"));
  assert.equal(h.db.writes.filter((w) => w.table === "invoices").length, 0);
});

// ------------------------------------------------------------------ deletion
const inv = (n, firm, by = "u1", status = "needs_review") => ({ id: uuid(n), firm_id: firm, storage_path: `${firm}/${uuid(n)}.pdf`, uploaded_by: by, status });
const remove = (id, o = {}) => del.DELETE(req(`/api/invoices/${id}`, { method: "DELETE", ...o }), { params: { id } });

test("delete: other-site and signed-out requests are refused; a malformed id is 404", async () => {
  const h = world({ tables: { invoices: [inv(1, F1)] } });
  assert.equal((await remove(uuid(1), { origin: "https://evil.test" })).status, 403);
  assert.equal((await remove(uuid(1), { origin: null })).status, 403);
  assert.equal((await remove("1; drop table invoices")).status, 404);
  assert.equal(h.db.writes.length, 0);
  world({ user: null, tables: { invoices: [inv(1, F1)] } });
  assert.equal((await remove(uuid(1))).status, 401);
});

test("delete: another firm's invoice is 'not found' and nothing is touched", async () => {
  // Row Level Security hides foreign rows from the user's client; the fake filter models that by returning no row.
  const h = world({ tables: { invoices: [] } });
  const res = await remove(uuid(9));
  assert.equal(res.status, 404);
  assert.equal(h.db.writes.length, 0);
  assert.equal(h.client.storage.removed.length, 0);
});

test("delete: a plain member may delete only their own uploads; owners and admins may delete any", async () => {
  let h = world({ role: "member", tables: { invoices: [inv(1, F1, "someone-else")] } });
  assert.equal((await remove(uuid(1))).status, 403);
  assert.equal(h.client.storage.removed.length, 0);
  h = world({ role: "member", tables: { invoices: [inv(1, F1, "u1")] } });
  assert.equal((await remove(uuid(1))).status, 200);
  h = world({ role: "admin", tables: { invoices: [inv(1, F1, "someone-else")] } });
  assert.equal((await remove(uuid(1))).status, 200);
});

test("delete: order is mark pending_deletion -> remove the file -> delete the row", async () => {
  const h = world({ tables: { invoices: [inv(1, F1)] }, objects: {} });
  h.client.storage.removed.length = 0;
  const res = await remove(uuid(1));
  assert.equal(res.status, 200);
  assert.equal(h.db.writes[0].op, "update");
  assert.equal(h.db.writes[0].patch.status, "pending_deletion");
  assert.ok(h.db.writes[0].patch.deletion_requested_at);
  assert.deepEqual(h.client.storage.removed, [`${F1}/${uuid(1)}.pdf`]);
  assert.equal(h.db.writes[1].op, "delete");
  assert.equal(h.db.data.invoices.length, 0);
});

test("delete: if the file cannot be removed the row stays 'pending_deletion' so the request can be retried", async () => {
  const h = world({ tables: { invoices: [inv(1, F1)] } });
  h.db.ctl.removeError = { message: "storage down" };
  const res = await remove(uuid(1));
  assert.equal(res.status, 502);
  assert.equal(h.db.data.invoices.length, 1, "row is kept");
  assert.equal(h.db.data.invoices[0].status, "pending_deletion");
  h.db.ctl.removeError = null; // the retry succeeds
  assert.equal((await remove(uuid(1))).status, 200);
  assert.equal(h.db.data.invoices.length, 0);
});

test("delete: if marking fails nothing is removed; if the final row delete fails the answer is a generic 500", async () => {
  let h = world({ tables: { invoices: [inv(1, F1)] } });
  h.db.ctl.writeErrors["invoices:update"] = { message: "boom host=db.internal" };
  const res = await readJson(await remove(uuid(1)));
  assert.equal(res.status, 500);
  assert.equal(h.client.storage.removed.length, 0);
  assert.ok(!JSON.stringify(res.body).includes("db.internal"));
  h = world({ tables: { invoices: [inv(1, F1)] } });
  h.db.ctl.writeErrors["invoices:delete"] = { message: "boom" };
  assert.equal((await remove(uuid(1))).status, 500);
});
