// The REAL server-side integration modules (route-helpers, store) against in-memory fakes of Supabase and a mocked global fetch.
// No Google or Microsoft account, no network. Covers: who may manage a connection, token refresh, rotation, revoked grants.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, world, req, readJson, uuid, F1, F2 } from "./helpers/route-harness.mjs";

setup();
process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GOOGLE_OAUTH_CLIENT_ID = "cid"; process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
process.env.MICROSOFT_OAUTH_CLIENT_ID = "mid"; process.env.MICROSOFT_OAUTH_CLIENT_SECRET = "msecret";
process.env.NEXT_PUBLIC_SITE_URL = "https://app.test";
const helpers = await import("../lib/integrations/route-helpers.ts");
const store = await import("../lib/integrations/store.ts");
const { encryptSecret, decryptSecret } = await import("../lib/integrations/crypto.ts");
const { IntegrationError } = await import("../lib/integrations/http.ts");

const CONN = uuid(900), OTHER = uuid(901);
const row = (over = {}) => ({ id: CONN, firm_id: F1, provider: "google_sheets", status: "active", refresh_token_enc: encryptSecret("RT-1", `${F1}:google_sheets`), access_token_enc: null, access_expires_at: null, target: {}, mapping: [], date_format: "iso", account_email: "a@b.test", ...over });
const ctx = (o = {}, id = CONN, init = {}) => { const h = world({ adminTables: { integration_connections: [row(), row({ id: OTHER, firm_id: F2 })] }, ...o }); return { h, p: helpers.managerWithConnection(req(`/api/integrations/connections/${id}`, { method: "POST", ...init }), id, true) }; };

test("managerWithConnection: other-site, signed-out, non-admin and malformed-id requests are refused before any lookup", async () => {
  let { h, p } = ctx({}, CONN, { origin: "https://evil.test" }); assert.equal((await p).response.status, 403); assert.equal(h.adminDb.log.length, 0);
  ({ p } = ctx({ user: null })); assert.equal((await p).response.status, 401);
  ({ h, p } = ctx({ role: "member" })); assert.equal((await p).response.status, 403); assert.equal(h.adminDb.log.length, 0);
  ({ h, p } = ctx({}, "../etc/passwd")); assert.equal((await p).response.status, 404); assert.equal(h.adminDb.log.length, 0);
  ({ p } = ctx({ admin: false })); assert.equal((await p).response.status, 503);
});

test("managerWithConnection: another firm's connection id is 'not found'; own connection is returned; the lookup carries firm_id", async () => {
  let { h, p } = ctx({}, OTHER); assert.equal((await p).response.status, 404);
  ({ h, p } = ctx()); const r = await p;
  assert.equal(r.ok, true); assert.equal(r.conn.id, CONN);
  const q = h.adminDb.log.find((x) => x.table === "integration_connections");
  assert.ok(q.filters.some(([op, c, v]) => op === "eq" && c === "firm_id" && v === F1));
});

test("providerError: safe message and an actionable status; provider text never reaches the browser", async () => {
  for (const [code, status] of [["auth_expired", 409], ["permission_denied", 403], ["not_found", 404], ["rate_limited", 429], ["timeout", 504], ["server_error", 502], ["network", 502], ["header_changed", 409]]) {
    const res = helpers.providerError(new IntegrationError(code, 0, "secret provider text"));
    const out = await readJson(res);
    assert.equal(out.status, status, code);
    assert.ok(!JSON.stringify(out.body).includes("secret provider text"));
  }
  assert.equal(helpers.providerError(new IntegrationError("rate_limited")).headers.get("retry-after"), "30");
  assert.equal(helpers.providerError(new Error("db password=x")).status, 502);
});

test("getAccessToken: a fresh stored token is used without calling the provider", async () => {
  const h = world({ adminTables: { integration_connections: [row()] } });
  const aad = `${F1}:google_sheets`;
  const conn = row({ access_token_enc: encryptSecret("AT-cached", aad), access_expires_at: new Date(Date.now() + 600_000).toISOString() });
  const saved = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("no network in tests"); };
  try { assert.equal(await store.getAccessToken(h.admin, conn), "AT-cached"); assert.equal(calls, 0); } finally { globalThis.fetch = saved; }
});

test("getAccessToken: expired token is refreshed, saved encrypted, and a rotated refresh token replaces the old one", async () => {
  const h = world({ adminTables: { integration_connections: [row({ provider: "microsoft_excel", refresh_token_enc: encryptSecret("RT-old", `${F1}:microsoft_excel`) })] } });
  const conn = h.adminDb.data.integration_connections[0];
  const saved = globalThis.fetch; let body = "";
  globalThis.fetch = async (url, init) => { body = String(init.body); return new Response(JSON.stringify({ access_token: "AT-new", refresh_token: "RT-rotated", expires_in: 3600 }), { status: 200 }); };
  try {
    assert.equal(await store.getAccessToken(h.admin, conn), "AT-new");
    assert.match(body, /grant_type=refresh_token/); assert.match(body, /refresh_token=RT-old/);
    const stored = h.adminDb.data.integration_connections[0];
    const aad = `${F1}:microsoft_excel`;
    assert.equal(decryptSecret(stored.access_token_enc, aad), "AT-new");
    assert.equal(decryptSecret(stored.refresh_token_enc, aad), "RT-rotated");
    assert.ok(!JSON.stringify(stored).includes("AT-new") && !JSON.stringify(stored).includes("RT-rotated"), "nothing is stored in plain text");
    assert.ok(Date.parse(stored.access_expires_at) > Date.now());
  } finally { globalThis.fetch = saved; }
});

test("getAccessToken: a revoked grant marks the connection 'needs_reauth' and throws auth_expired", async () => {
  const h = world({ adminTables: { integration_connections: [row()] } });
  const saved = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  try {
    await assert.rejects(store.getAccessToken(h.admin, h.adminDb.data.integration_connections[0]), (e) => e instanceof IntegrationError && e.code === "auth_expired");
    assert.equal(h.adminDb.data.integration_connections[0].status, "needs_reauth");
    assert.match(h.adminDb.data.integration_connections[0].last_error, /Reconnect/);
  } finally { globalThis.fetch = saved; }
});

test("getAccessToken: a token that cannot be decrypted (key lost or copied from another firm) needs reconnecting; inactive connections are refused", async () => {
  const h = world({ adminTables: { integration_connections: [row({ refresh_token_enc: encryptSecret("RT", `${F2}:google_sheets`) })] } });
  await assert.rejects(store.getAccessToken(h.admin, h.adminDb.data.integration_connections[0]), (e) => e.code === "auth_expired");
  assert.equal(h.adminDb.data.integration_connections[0].status, "needs_reauth");
  await assert.rejects(store.getAccessToken(h.admin, row({ status: "revoked" })), (e) => e.code === "auth_expired");
});

test("a connection that was revoked by the user is never switched back to needs_reauth", async () => {
  const h = world({ adminTables: { integration_connections: [row({ status: "revoked" })] } });
  await store.markNeedsReauth(h.admin, { id: CONN, firm_id: F1 });
  assert.equal(h.adminDb.data.integration_connections[0].status, "revoked");
});

test("ledger: claim and finish call the database functions with the connection's firm, never anything else", async () => {
  const answers = ["claimed", "already_synced", "in_progress", `duplicate_of:${uuid(5)}`];
  const h = world({ rpc: { claim_sync_record: () => ({ data: answers.shift(), error: null }), finish_sync_record: () => ({ data: null, error: null }) }, adminTables: { integration_connections: [row()] } });
  const fails = [];
  const ledger = store.makeLedger(h.admin, { id: CONN, firm_id: F1 }, (c, m) => fails.push([c, m]));
  assert.deepEqual(await ledger.claim(uuid(1), "K"), { kind: "claimed" });
  assert.deepEqual(await ledger.claim(uuid(1), "K"), { kind: "already_synced" });
  assert.deepEqual(await ledger.claim(uuid(1), "K"), { kind: "in_progress" });
  assert.deepEqual(await ledger.claim(uuid(1), "K"), { kind: "duplicate_of", invoiceId: uuid(5) });
  await ledger.finish(uuid(1), { status: "failed", code: "rate_limited", message: "slow down" });
  await ledger.finish(uuid(2), { status: "synced", row: 7 });
  assert.deepEqual(fails, [["rate_limited", "slow down"]]);
  assert.ok(h.adminDb.rpcLog.every((c) => c.args.p_firm_id === F1 && c.args.p_connection_id === CONN));
  assert.equal(h.adminDb.rpcLog.at(-1).args.p_external_row, 7);
});

test("ledger: a database error is not hidden as success", async () => {
  const h = world({ rpc: { claim_sync_record: () => ({ data: null, error: { message: "boom" } }), finish_sync_record: () => ({ data: null, error: { message: "boom" } }) } });
  const ledger = store.makeLedger(h.admin, { id: CONN, firm_id: F1 }, () => {});
  await assert.rejects(ledger.claim(uuid(1), null));
  await assert.rejects(ledger.finish(uuid(1), { status: "synced", row: 1 }));
});

test("provider configuration: callback URLs come from NEXT_PUBLIC_SITE_URL; missing secrets mean 'not configured'", () => {
  const c = store.providerConfigs({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b" });
  assert.equal(c.google.redirectUri, "https://app.test/api/integrations/oauth/google_sheets/callback");
  assert.equal(c.microsoft, null);
  const m = store.providerConfigs({ MICROSOFT_OAUTH_CLIENT_ID: "a", MICROSOFT_OAUTH_CLIENT_SECRET: "b" });
  assert.equal(m.microsoft.redirectUri, "https://app.test/api/integrations/oauth/microsoft_excel/callback");
  assert.equal(m.microsoft.tenant, "common");
  assert.equal(store.providerConfigs({}).google, null);
  assert.ok(!store.PUBLIC_CONNECTION_COLUMNS.includes("token"), "the browser-readable column list never contains a token column");
});
