// Background worker: the cron route is closed without the secret, fails stale jobs of every firm, and starts queued ones without a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid } from "./helpers/route-harness.mjs";

setup();
const cron = await import("../app/api/cron/extraction/route.ts");
const call = (headers = {}, method = "GET") => cron[method](req("/api/cron/extraction", { method, origin: null, headers }));

function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
const ON = { CRON_SECRET: "s3cret-value", GEMINI_API_KEY: "k" };

test("cron: closed (503) while CRON_SECRET is not set, 403 for a missing or wrong token, never touches the database", async () => {
  const h = world();
  await withEnv({ CRON_SECRET: undefined, GEMINI_API_KEY: "k" }, async () => assert.equal((await call({ authorization: "Bearer anything" })).status, 503));
  await withEnv(ON, async () => {
    assert.equal((await call()).status, 403);
    assert.equal((await call({ authorization: "Bearer wrong" })).status, 403);
    assert.equal((await call({ authorization: "s3cret-value" })).status, 403, "the Bearer prefix is required");
    assert.equal((await call({ authorization: "Bearer s3cret-value-and-more" })).status, 403);
  });
  assert.equal(h.adminDb.rpcLog.length, 0);
});

test("cron: 503 when the server has no AI key or no service-role client", async () => {
  world();
  await withEnv({ CRON_SECRET: "s3cret-value", GEMINI_API_KEY: undefined }, async () => assert.equal((await call({ authorization: "Bearer s3cret-value" })).status, 503));
  world({ admin: false });
  await withEnv(ON, async () => assert.equal((await call({ authorization: "Bearer s3cret-value" })).status, 503));
});

test("cron: fails stale jobs of ALL firms first, then claims each queued job (busy / taken ones are skipped, nothing crashes)", async () => {
  const queued = [uuid(1), uuid(2), uuid(3)].map((id, i) => ({ job_id: uuid(100 + i), invoice_id: id, firm_id: i === 2 ? "f2" : "f1", requested_by: "u1" }));
  const h = world({
    rpc: {
      reap_stale_extraction_jobs: () => ({ data: 2, error: null }),
      list_queued_extraction_jobs: () => ({ data: queued, error: null }),
      claim_extraction_job: ({ p_invoice_id }) => ({ data: { result: p_invoice_id === uuid(1) ? "busy" : "not_queued" }, error: null }),
    },
  });
  await withEnv(ON, async () => {
    for (const method of ["GET", "POST"]) {
      h.adminDb.rpcLog.length = 0;
      const res = await readJson(await call({ authorization: "Bearer s3cret-value" }, method));
      assert.equal(res.status, 200);
      assert.deepEqual({ ok: res.body.ok, reaped: res.body.reaped, listed: res.body.listed, started: res.body.started, skipped: res.body.skipped }, { ok: true, reaped: 2, listed: 3, started: 0, skipped: 3 });
      const names = h.adminDb.rpcLog.map((c) => c.name);
      assert.equal(names[0], "reap_stale_extraction_jobs", "stale jobs are failed before new work starts");
      assert.equal(names[1], "list_queued_extraction_jobs");
      assert.equal(names.filter((n) => n === "claim_extraction_job").length, 3);
      assert.ok(h.adminDb.rpcLog.find((c) => c.name === "claim_extraction_job" && c.args.p_firm_id === "f2"), "each job is claimed for ITS firm");
    }
  });
});

test("cron: a failing list or reap call is logged and answered, the worker does not throw", async () => {
  world({ rpc: { reap_stale_extraction_jobs: () => ({ data: null, error: { code: "XX000" } }), list_queued_extraction_jobs: () => ({ data: null, error: { code: "XX000" } }) } });
  await withEnv(ON, async () => {
    const res = await readJson(await call({ authorization: "Bearer s3cret-value" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.listed, 0);
  });
});
