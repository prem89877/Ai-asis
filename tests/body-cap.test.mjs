import test from "node:test";
import assert from "node:assert/strict";
import { readFormDataCapped, readJsonBody } from "../lib/api/body.ts";

// A body that is streamed in pieces and carries NO Content-Length header, like a chunked request.
function chunked(parts, headers = {}) {
  let i = 0;
  const stream = new ReadableStream({ pull(c) { i < parts.length ? c.enqueue(typeof parts[i] === "string" ? new TextEncoder().encode(parts[i++]) : parts[i++]) : c.close(); } });
  return new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half", headers });
}

test("readJsonBody: a chunked body without Content-Length is stopped at the cap", async () => {
  const req = chunked(["{\"a\":\"", "x".repeat(600), "\"}"]);
  assert.equal(req.headers.get("content-length"), null);
  const r = await readJsonBody(req, 512);
  assert.deepEqual([r.ok, r.status], [false, 413]);
});
test("readJsonBody: stops reading early (does not buffer the rest)", async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 1000) c.close(); } });
  const r = await readJsonBody(new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" }), 4096);
  assert.equal(r.status, 413);
  assert.ok(pulled < 20, `pulled ${pulled}`);
});
test("readJsonBody: normal bodies, bad JSON, empty body, multi-byte text, declared-too-large", async () => {
  assert.deepEqual(await readJsonBody(chunked(["{\"a\":", "1}"])), { ok: true, value: { a: 1 } });
  assert.equal((await readJsonBody(chunked(["{nope"]))).status, 400);
  assert.equal((await readJsonBody(new Request("http://localhost/x", { method: "POST" }))).status, 400); // empty -> not JSON
  const euro = new TextEncoder().encode("{\"a\":\"₹\"}");
  assert.deepEqual(await readJsonBody(chunked([euro.slice(0, 7), euro.slice(7)])), { ok: true, value: { a: "₹" } }); // multi-byte char split across chunks
  assert.equal((await readJsonBody(chunked(["{}"], { "content-length": "999999" }), 1024)).status, 413);
});
test("readFormDataCapped: a chunked multipart upload over the cap is refused; under the cap it parses", async () => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(50_000)], "a.pdf", { type: "application/pdf" }));
  fd.append("batch_id", "x");
  const src = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await src.arrayBuffer());
  const type = src.headers.get("content-type");
  const mk = () => chunked([bytes.slice(0, 20_000), bytes.slice(20_000)], { "content-type": type });
  const small = await readFormDataCapped(mk(), 100_000);
  assert.equal(small.ok, true);
  assert.equal(small.form.get("file").size, 50_000);
  assert.equal(small.form.get("batch_id"), "x");
  const big = await readFormDataCapped(mk(), 30_000);
  assert.deepEqual([big.ok, big.status], [false, 413]);
  assert.equal((await readFormDataCapped(new Request("http://localhost/x", { method: "POST" }), 1000)).status, 400);
});
