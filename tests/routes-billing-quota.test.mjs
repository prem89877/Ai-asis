// Quota and billing at route level. The quota itself is enforced inside the database (enqueue_metered_jobs, see
// supabase/tests/phase5_billing.test.sql); these tests check how the routes pass identity to it and what they tell the user.
// There is NO payment gateway in the codebase, so there is nothing to test for billing webhooks (see docs/PHASE6_PART2_RELEASE.md).
import test from "node:test";
import assert from "node:assert/strict";
import { setup, world, req, readJson, uuid, F1 } from "./helpers/route-harness.mjs";

setup();
const enqueue = await import("../app/api/invoices/enqueue/route.ts");
const change = await import("../app/api/billing/change-plan/route.ts");

process.env.GEMINI_API_KEY = "test-key-not-real";
const ids = (n) => Array.from({ length: n }, (_, i) => uuid(i + 1));
const q = { used: 25, limit: 25, remaining: 0 };
const run = (body, rpcResult, o = {}) => {
  const h = world({ rpc: { enqueue_metered_jobs: () => (rpcResult instanceof Error ? { data: null, error: { code: "XX000", message: "db down" } } : { data: rpcResult, error: null }) }, ...(o.world ?? {}) });
  return enqueue.POST(req("/api/invoices/enqueue", { body, ...(o.req ?? {}) })).then((res) => ({ h, res }));
};

test("enqueue: guards and input validation", async () => {
  assert.equal((await run({ invoiceIds: ids(1) }, { enqueued: [], skipped: [] }, { req: { origin: "https://evil.test" } })).res.status, 403);
  assert.equal((await run({ invoiceIds: ids(1) }, {}, { world: { user: null } })).res.status, 401);
  assert.equal((await run({ invoiceIds: ids(1) }, {}, { world: { members: [] } })).res.status, 403);
  for (const bad of [{}, { invoiceIds: [] }, { invoiceIds: ["x"] }, { invoiceIds: "abc" }, { invoiceIds: ids(101) }]) {
    assert.equal((await run(bad, {})).res.status, 400, JSON.stringify(bad).slice(0, 30));
  }
});

test("enqueue: the firm and user sent to the database come from the session, never the body", async () => {
  const { h } = await run({ invoiceIds: [uuid(1), uuid(1)], firmId: "evil", p_firm_id: "evil" }, { enqueued: [{ invoice_id: uuid(1), job_id: uuid(50) }], skipped: [], quota: { used: 1, limit: 25, remaining: 24 } });
  const call = h.adminDb.rpcLog[0];
  assert.equal(call.name, "enqueue_metered_jobs");
  assert.equal(call.args.p_firm_id, F1);
  assert.equal(call.args.p_user_id, "u1");
  assert.deepEqual(call.args.p_invoice_ids, [uuid(1)], "duplicates are removed");
});

test("enqueue: missing AI key or service key is 503 and nothing is queued", async () => {
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { h, res } = await run({ invoiceIds: ids(1) }, { enqueued: [], skipped: [] });
    assert.equal(res.status, 503);
    assert.equal(h.adminDb.rpcLog.length, 0);
  } finally { process.env.GEMINI_API_KEY = key; }
  assert.equal((await run({ invoiceIds: ids(1) }, {}, { world: { admin: false } })).res.status, 503);
});

test("quota: all units used -> 402 quota_exceeded with the numbers; some units left -> 200 with the rest skipped", async () => {
  const full = await run({ invoiceIds: ids(2) }, { enqueued: [], skipped: ids(2).map((id) => ({ invoice_id: id, reason: "quota_exceeded" })), quota: q });
  const body = await readJson(full.res);
  assert.equal(body.status, 402);
  assert.equal(body.body.code, "quota_exceeded");
  assert.deepEqual(body.body.quota, q);
  const part = await readJson((await run({ invoiceIds: ids(2) }, { enqueued: [{ invoice_id: uuid(1), job_id: uuid(50) }], skipped: [{ invoice_id: uuid(2), reason: "quota_exceeded" }], quota: q })).res);
  assert.equal(part.status, 200);
  assert.equal(part.body.enqueued.length, 1);
  assert.deepEqual(part.body.skipped, [{ invoiceId: uuid(2), reason: "quota_exceeded" }]);
});

test("quota: batch limit 400, inactive subscription 402, no subscription 409, per-minute limit 429", async () => {
  const batch = await readJson((await run({ invoiceIds: ids(8) }, { error: "batch_limit", max: 5 })).res);
  assert.equal(batch.status, 400); assert.equal(batch.body.code, "batch_limit"); assert.equal(batch.body.maxFiles, 5);
  const inactive = await readJson((await run({ invoiceIds: ids(1) }, { error: "subscription_inactive" })).res);
  assert.equal(inactive.status, 402); assert.equal(inactive.body.code, "subscription_inactive");
  assert.equal((await run({ invoiceIds: ids(1) }, { error: "no_subscription" })).res.status, 409);
  const rl = (await run({ invoiceIds: ids(1) }, { enqueued: [], skipped: [{ invoice_id: uuid(1), reason: "rate_limited" }] })).res;
  assert.equal(rl.status, 429); assert.equal(rl.headers.get("retry-after"), "30");
});

test("quota: ids the database did not know (other firm's or deleted) are reported as not_found, not queued", async () => {
  const { res } = await run({ invoiceIds: [uuid(1), uuid(2)] }, { enqueued: [{ invoice_id: uuid(1), job_id: uuid(50) }], skipped: [] });
  const out = await readJson(res);
  assert.deepEqual(out.body.skipped, [{ invoiceId: uuid(2), reason: "not_found" }]);
});

test("quota: a database failure is a generic 500", async () => {
  const { res } = await run({ invoiceIds: ids(1) }, new Error("x"));
  const out = await readJson(res);
  assert.equal(out.status, 500);
  assert.ok(!JSON.stringify(out.body).includes("db down"));
});

// ---- change-plan (no payment gateway exists: paid upgrades are never applied by the browser)
const changePlan = (planCode, rpcData, env = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const h = world({ rpc: { change_plan: () => ({ data: rpcData, error: null }) } });
  return change.POST(req("/api/billing/change-plan", { body: { planCode } })).then((res) => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return { h, res };
  });
};

test("change-plan: plan code is validated; owner/admin check and price/limits come from the database", async () => {
  assert.equal((await changePlan("DROP TABLE", {})).res.status, 400);
  assert.equal((await changePlan("solo", { result: "forbidden" })).res.status, 403);
  assert.equal((await changePlan("nope", { result: "unknown_plan" })).res.status, 400);
  assert.equal((await changePlan("solo", { result: "no_subscription" })).res.status, 409);
  assert.equal((await changePlan("solo", { result: "something_new" })).res.status, 500);
  const down = await readJson((await changePlan("pilot", { result: "downgrade_scheduled", effective_at: "2026-11-01", pending_plan_code: "pilot" })).res);
  assert.equal(down.status, 200); assert.equal(down.body.pendingPlanCode, "pilot");
});

test("change-plan: an upgrade without payment is 'payment_required' (202); the unpaid-upgrade flag is ignored in production", async () => {
  const prod = await changePlan("solo", { result: "payment_required" }, { NODE_ENV: "production", VERCEL_ENV: "production", BILLING_ALLOW_UNPAID_UPGRADES: "true" });
  assert.equal(prod.res.status, 202);
  assert.equal(prod.h.adminDb.rpcLog[0].args.p_allow_unpaid_upgrade, false);
  assert.equal(prod.h.adminDb.rpcLog[0].args.p_firm_id, F1);
  const dev = await changePlan("solo", { result: "upgraded" }, { NODE_ENV: "development", VERCEL_ENV: undefined, BILLING_ALLOW_UNPAID_UPGRADES: "true" });
  assert.equal(dev.h.adminDb.rpcLog[0].args.p_allow_unpaid_upgrade, true);
});

test("billing webhooks: no payment gateway or webhook route exists, so none is tested (this guard fails if one is added without tests)", async () => {
  const { readdirSync } = await import("node:fs");
  const dirs = readdirSync(new URL("../app/api", import.meta.url));
  assert.ok(!dirs.some((d) => /webhook|razorpay|stripe|payment/i.test(d)), "if a payment/webhook route is added, write its signature, replay and ordering tests and update docs");
});
