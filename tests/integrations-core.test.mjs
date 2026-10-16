import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, isEncryptionConfigured, loadKeys } from "../lib/integrations/crypto.ts";
import { codeChallenge, hashState, newCodeVerifier, newState, readIdTokenClaims } from "../lib/integrations/oauth.ts";
import { IntegrationError, classifyStatus, providerFetch, userMessage } from "../lib/integrations/http.ts";
import { buildRow, colLetters, dedupeKey, defaultMapping, excelTextGuard, headersMatch, parseSpreadsheetId, quoteSheet, validateMapping, DEFAULT_SYNC_FIELDS } from "../lib/integrations/mapping.ts";
import { syncInvoices } from "../lib/integrations/sync.ts";
import { googleAuthUrl, googleDriver, googleExchangeCode, googleRefresh } from "../lib/integrations/google.ts";
import { microsoftAuthUrl, microsoftDriver, microsoftRefresh, msSearchWorkbooks, MICROSOFT_SCOPES } from "../lib/integrations/microsoft.ts";

const key = () => randomBytes(32).toString("base64");
const env = { INTEGRATION_ENCRYPTION_KEY: key() };

// ---------- crypto ----------
test("encrypt/decrypt round trip, random IV, no plaintext in output", () => {
  const a = encryptSecret("refresh-token-123", "firm:google", env);
  const b = encryptSecret("refresh-token-123", "firm:google", env);
  assert.notEqual(a, b);
  assert.ok(!a.includes("refresh-token-123"));
  assert.equal(decryptSecret(a, "firm:google", env), "refresh-token-123");
});
test("decrypt fails for another owner (aad), tampering, wrong key, junk", () => {
  const c = encryptSecret("secret", "firmA:google", env);
  assert.equal(decryptSecret(c, "firmB:google", env), null);
  const parts = c.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.equal(decryptSecret(parts.join("."), "firmA:google", env), null);
  assert.equal(decryptSecret(c, "firmA:google", { INTEGRATION_ENCRYPTION_KEY: key() }), null);
  assert.equal(decryptSecret("not-a-token", "x", env), null);
});
test("key rotation: previous key still decrypts", () => {
  const old = key(), next = key();
  const c = encryptSecret("tok", "a", { INTEGRATION_ENCRYPTION_KEY: old });
  assert.equal(decryptSecret(c, "a", { INTEGRATION_ENCRYPTION_KEY: next, INTEGRATION_ENCRYPTION_KEY_PREVIOUS: old }), "tok");
});
test("key must be 32 bytes; missing key is reported", () => {
  assert.throws(() => loadKeys({ INTEGRATION_ENCRYPTION_KEY: Buffer.from("short").toString("base64") }));
  assert.equal(isEncryptionConfigured({}), false);
  assert.equal(isEncryptionConfigured(env), true);
});

// ---------- oauth helpers ----------
test("PKCE challenge matches RFC 7636 example; state and verifier are unique and hashed", () => {
  assert.equal(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.notEqual(newState(), newState());
  assert.ok(newCodeVerifier().length >= 43);
  assert.match(hashState("abc"), /^[0-9a-f]{64}$/);
});
test("id_token email is read, bad tokens give null", () => {
  const tok = (c) => `h.${Buffer.from(JSON.stringify(c)).toString("base64url")}.s`;
  assert.equal(readIdTokenClaims(tok({ email: "a@b.in" })).email, "a@b.in");
  assert.equal(readIdTokenClaims(tok({ preferred_username: "x@y.com" })).email, "x@y.com");
  assert.equal(readIdTokenClaims("garbage").email, null);
  assert.equal(readIdTokenClaims(undefined).email, null);
});

// ---------- http: retries, timeouts, classification ----------
const res = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => {};

test("status classification", () => {
  assert.equal(classifyStatus(401), "auth_expired");
  assert.equal(classifyStatus(403), "permission_denied");
  assert.equal(classifyStatus(404), "not_found");
  assert.equal(classifyStatus(429), "rate_limited");
  assert.equal(classifyStatus(503), "server_error");
  assert.equal(classifyStatus(400), "bad_request");
});
test("idempotent GET retries 503 then succeeds", async () => {
  let n = 0;
  const r = await providerFetch("https://x", {}, { idempotent: true, sleep: noSleep, fetchImpl: async () => (++n < 3 ? res(503) : res(200, { ok: 1 })) });
  assert.equal(n, 3);
  assert.deepEqual(r.json, { ok: 1 });
});
test("idempotent GET gives up after maxAttempts with a clear error", async () => {
  let n = 0;
  await assert.rejects(providerFetch("https://x", {}, { idempotent: true, sleep: noSleep, fetchImpl: async () => (n++, res(500)) }), (e) => e instanceof IntegrationError && e.code === "server_error");
  assert.equal(n, 3);
});
test("429 honours Retry-After and is retried even for appends", async () => {
  const waits = []; let n = 0;
  const r = await providerFetch("https://x", { method: "POST" }, { idempotent: false, sleep: async (ms) => waits.push(ms), fetchImpl: async () => (++n === 1 ? res(429, {}, { "retry-after": "2" }) : res(200, {})) });
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [2000]);
});
test("append is NEVER retried after 5xx or network failure (could duplicate rows)", async () => {
  let n = 0;
  await assert.rejects(providerFetch("https://x", { method: "POST" }, { idempotent: false, sleep: noSleep, fetchImpl: async () => (n++, res(500)) }));
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(providerFetch("https://x", { method: "POST" }, { idempotent: false, sleep: noSleep, fetchImpl: async () => { n++; throw new TypeError("fetch failed"); } }), (e) => e.code === "network");
  assert.equal(n, 1);
});
test("401/403/404 are not retried", async () => {
  for (const [s, code] of [[401, "auth_expired"], [403, "permission_denied"], [404, "not_found"]]) {
    let n = 0;
    await assert.rejects(providerFetch("https://x", {}, { idempotent: true, sleep: noSleep, fetchImpl: async () => (n++, res(s)) }), (e) => e.code === code);
    assert.equal(n, 1);
  }
});
test("timeout aborts the request and is reported as timeout", async () => {
  const hang = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(providerFetch("https://x", {}, { idempotent: false, timeoutMs: 20, fetchImpl: hang }), (e) => e.code === "timeout");
});
test("timeout also covers the response BODY: headers arrive, body hangs -> aborted, status still decides", async () => {
  const slowBody = (_u, init) => Promise.resolve({
    status: 200, headers: new Headers(),
    text: () => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  const t0 = Date.now();
  const r = await providerFetch("https://x", {}, { idempotent: false, timeoutMs: 30, fetchImpl: slowBody });
  assert.equal(r.status, 200); // the write was accepted; only the body was lost (the sync recovers through the AI Asis ID column)
  assert.equal(r.json, null);
  assert.ok(Date.now() - t0 < 1000);
  await assert.rejects(providerFetch("https://x", {}, { idempotent: true, maxAttempts: 1, timeoutMs: 30, fetchImpl: async (u, i) => ({ ...(await slowBody(u, i)), status: 500 }) }), (e) => e.code === "server_error");
});
test("deadline: a rate-limit wait that would not fit is not taken; the call fails cleanly instead of running past the route limit", async () => {
  const waits = [];
  let n = 0;
  await assert.rejects(
    providerFetch("https://x", { method: "POST" }, { idempotent: false, deadlineAt: Date.now() + 5_000, sleep: async (ms) => waits.push(ms), fetchImpl: async () => (n++, res(429, {}, { "retry-after": "30" })) }),
    (e) => e.code === "rate_limited",
  );
  assert.equal(n, 1);
  assert.deepEqual(waits, []);
  // a short wait that fits is still taken
  n = 0;
  const ok = await providerFetch("https://x", {}, { idempotent: true, deadlineAt: Date.now() + 20_000, sleep: async (ms) => waits.push(ms), fetchImpl: async () => (++n === 1 ? res(429, {}, { "retry-after": "2" }) : res(200, { ok: 1 })) });
  assert.equal(ok.status, 200);
  assert.deepEqual(waits, [2000]);
  // deadline already passed: no request at all
  let called = 0;
  await assert.rejects(providerFetch("https://x", {}, { idempotent: true, deadlineAt: Date.now() - 1, fetchImpl: async () => { called++; return res(200); } }), (e) => e.code === "timeout");
  assert.equal(called, 0);
});
test("user messages never leak internals", () => {
  assert.match(userMessage(new IntegrationError("auth_expired")).message, /Reconnect/);
  assert.equal(userMessage(new Error("secret db password")).code, "unknown");
  assert.ok(!userMessage(new Error("secret db password")).message.includes("secret"));
});

// ---------- mapping ----------
const inv = (o = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00",
  vendor_name: "Acme Traders", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", buyer_gstin: null, invoice_number: "0012",
  invoice_date: "2026-09-15", place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000,
  discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180,
  confidence: 0.9, review_flags: [], verified_at: "2026-10-11T05:00:00+00:00", ...o,
});
const map = (fields) => defaultMapping(fields);

test("mapping validation: needs id, rejects unknown and duplicate fields", () => {
  assert.equal(validateMapping([{ header: "A", field: "invoice_number" }]).ok, false);
  assert.equal(validateMapping([{ header: "A", field: "nope" }, { header: "B", field: "id" }]).ok, false);
  assert.equal(validateMapping([{ header: "A", field: "id" }, { header: "B", field: "id" }]).ok, false);
  assert.equal(validateMapping([]).ok, false);
  assert.equal(validateMapping("x").ok, false);
  assert.equal(validateMapping([{ header: "X", field: "id" }, { header: "skip", field: null }]).ok, true);
});
test("default mapping always contains the AI Asis ID", () => {
  assert.ok(defaultMapping(["invoice_number"]).some((m) => m.field === "id"));
  assert.equal(defaultMapping([...DEFAULT_SYNC_FIELDS]).length, DEFAULT_SYNC_FIELDS.length);
});
test("headersMatch detects a changed header row", () => {
  const m = [{ header: "Invoice No", field: "invoice_number" }, { header: "", field: null }, { header: "AI Asis ID", field: "id" }];
  assert.equal(headersMatch(m, [" invoice no ", "x", "ai asis id"]), true);
  assert.equal(headersMatch(m, ["Number", "x", "AI Asis ID"]), false);
  assert.equal(headersMatch(m, ["Invoice No"]), false);
});
test("buildRow follows mapping order, blanks for skipped columns, numbers stay numbers", () => {
  const m = [{ header: "ID", field: "id" }, { header: "skip", field: null }, { header: "Total", field: "total_amount" }, { header: "Date", field: "invoice_date" }, { header: "Supplier", field: "vendor_name" }];
  assert.deepEqual(buildRow(inv(), m, "dmy", "none"), ["11111111-1111-4111-8111-111111111111", "", 1180, "15/09/2026", "Acme Traders"]);
  assert.deepEqual(buildRow(inv({ total_amount: null }), m, "iso", "none")[2], "");
});
test("Excel text guard: formulas, leading-zero numbers and dates are stored as text", () => {
  assert.equal(excelTextGuard("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(excelTextGuard("+91"), "'+91");
  assert.equal(excelTextGuard("0012"), "'0012");
  assert.equal(excelTextGuard("15/09/2026"), "'15/09/2026");
  assert.equal(excelTextGuard("INV-0012"), "INV-0012");
  const m = [{ header: "No", field: "invoice_number" }, { header: "Date", field: "invoice_date" }, { header: "Name", field: "vendor_name" }, { header: "ID", field: "id" }];
  const row = buildRow(inv({ vendor_name: "=cmd|' /C calc'!A0" }), m, "iso", "excel");
  assert.equal(row[0], "'0012"); assert.equal(row[1], "'2026-09-15"); assert.ok(String(row[2]).startsWith("'="));
  // Google RAW needs no apostrophe
  assert.equal(buildRow(inv({ vendor_name: "=1+1" }), m, "iso", "none")[2], "=1+1");
});
test("dedupe key: same supplier + number + FY matches, other FY or supplier does not, no number = null", () => {
  const a = dedupeKey(inv()), b = dedupeKey(inv({ invoice_number: " 0012 ", vendor_gstin: "27aapfu0939f1zv" }));
  assert.equal(a, b);
  assert.notEqual(a, dedupeKey(inv({ invoice_date: "2027-05-01" })));
  assert.equal(dedupeKey(inv({ invoice_date: "2027-02-01" })), dedupeKey(inv({ invoice_date: "2026-04-01" }))); // same FY 2026-27
  // The supplier is the NAME (GSTIN only when there is no name): a misread GSTIN no longer hides a duplicate...
  assert.equal(a, dedupeKey(inv({ vendor_gstin: "29AAPFU0939F1ZV" })));
  assert.notEqual(a, dedupeKey(inv({ vendor_name: "Other Traders" })));
  assert.ok(dedupeKey(inv({ vendor_name: null, vendor_gstin: "27AAPFU0939F1ZV" })).startsWith("27AAPFU0939F1ZV|"));
  // ...and "12/3" and "1/23" are different invoices (they used to collapse into "123").
  assert.notEqual(dedupeKey(inv({ invoice_number: "12/3" })), dedupeKey(inv({ invoice_number: "1/23" })));
  assert.equal(dedupeKey(inv({ invoice_number: "inv/12" })), dedupeKey(inv({ invoice_number: "INV 12" })));
  assert.equal(dedupeKey(inv({ invoice_number: null })), null);
  assert.ok(dedupeKey(inv({ vendor_gstin: null })).startsWith("ACMETRADERS|"));
});
test("spreadsheet link parsing and A1 helpers", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";
  assert.equal(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.equal(parseSpreadsheetId(id), id);
  assert.equal(parseSpreadsheetId("https://evil.example/spreadsheets/d/" + id), null);
  assert.equal(parseSpreadsheetId("http://docs.google.com/spreadsheets/d/" + id), null);
  assert.equal(parseSpreadsheetId("../../etc/passwd"), null);
  assert.equal(parseSpreadsheetId(""), null);
  assert.deepEqual([0, 25, 26, 701].map(colLetters), ["A", "Z", "AA", "ZZ"]);
  assert.equal(quoteSheet("Bob's sheet"), "'Bob''s sheet'");
});

// ---------- sync orchestration with fakes ----------
function fakeLedger(preset = {}) {
  const state = new Map(); const log = [];
  const synced = new Map(); // dedupe key -> invoice id
  return {
    log, state,
    async claim(id, key) {
      if (preset[id]) return preset[id];
      if (state.get(id)?.status === "synced") return { kind: "already_synced" };
      if (key && synced.has(key) && synced.get(key) !== id) return { kind: "duplicate_of", invoiceId: synced.get(key) };
      state.set(id, { status: "syncing", key }); return { kind: "claimed" };
    },
    async finish(id, r) { log.push([id, r.status, r.code ?? null]); state.set(id, { ...state.get(id), status: r.status }); if (r.status === "synced") synced.set(state.get(id).key, id); },
  };
}
function fakeDriver({ headers, present = [], failAppend = null, failHeaders = null } = {}) {
  const calls = { append: [] };
  return {
    calls, guard: "none",
    async readHeaders() { if (failHeaders) throw failHeaders; return headers; },
    async readColumn() { return present; },
    async append(rows) { if (failAppend) throw failAppend; calls.append.push(rows); return { firstRow: 10 }; },
  };
}
const M = map(["invoice_number", "total_amount", "id"]);
const H = M.map((m) => m.header);
const I2 = "22222222-2222-4222-8222-222222222222";

test("sync: verified invoices are appended in ONE request, unverified are skipped", async () => {
  const d = fakeDriver({ headers: H }), l = fakeLedger();
  const out = await syncInvoices({ invoices: [inv(), inv({ id: I2, invoice_number: "13" }), inv({ id: "33333333-3333-4333-8333-333333333333", status: "needs_review" })], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.deepEqual(out.map((o) => o.status), ["synced", "synced", "not_verified"]);
  assert.equal(d.calls.append.length, 1);
  assert.equal(d.calls.append[0].length, 2);
});
test("sync: running twice never appends twice (ledger says already_synced)", async () => {
  const d = fakeDriver({ headers: H }), l = fakeLedger();
  const args = { invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l };
  await syncInvoices(args);
  const second = await syncInvoices(args);
  assert.equal(second[0].status, "already_synced");
  assert.equal(d.calls.append.length, 1);
});
test("sync: same real invoice uploaded twice (different ids) is skipped as duplicate", async () => {
  const d = fakeDriver({ headers: H }), l = fakeLedger();
  await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  const out = await syncInvoices({ invoices: [inv({ id: I2 })], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.equal(out[0].status, "duplicate");
  assert.equal(d.calls.append.length, 1);
});
test("sync: lost-response recovery. Row already in the sheet is marked synced, not appended again", async () => {
  const d = fakeDriver({ headers: H, present: [inv().id] }), l = fakeLedger();
  const out = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.equal(out[0].status, "recovered");
  assert.equal(d.calls.append.length, 0);
});
test("sync: provider failure marks every row failed with a useful message, then a retry succeeds", async () => {
  let l = fakeLedger();
  const bad = fakeDriver({ headers: H, failAppend: new IntegrationError("rate_limited", 429) });
  const out = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: bad, ledger: l });
  assert.equal(out[0].status, "failed");
  assert.match(out[0].message, /limiting requests/);
  assert.deepEqual(l.log[0], [inv().id, "failed", "rate_limited"]);
  l.state.set(inv().id, { status: "failed", key: dedupeKey(inv()) }); // ledger lets failed rows be claimed again
  const good = fakeDriver({ headers: H });
  const retry = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: good, ledger: l });
  assert.equal(retry[0].status, "synced");
});
test("sync: changed header row stops the sync before any write", async () => {
  const d = fakeDriver({ headers: ["Something", "else", "entirely"] }), l = fakeLedger();
  const out = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.equal(out[0].status, "failed");
  assert.match(out[0].message, /header row/);
  assert.equal(d.calls.append.length, 0);
});
test("sync: expired authorization is reported as reconnect, revoked token never writes", async () => {
  const d = fakeDriver({ headers: H, failHeaders: new IntegrationError("auth_expired", 401) }), l = fakeLedger();
  const out = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.equal(out[0].status, "failed");
  assert.match(out[0].message, /Reconnect/);
  assert.equal(l.log[0][2], "auth_expired");
});
test("sync: row 'in progress' in another run is left alone", async () => {
  const d = fakeDriver({ headers: H }), l = fakeLedger({ [inv().id]: { kind: "in_progress" } });
  const out = await syncInvoices({ invoices: [inv()], mapping: M, dateFormat: "iso", driver: d, ledger: l });
  assert.equal(out[0].status, "in_progress");
  assert.equal(d.calls.append.length, 0);
});

// ---------- Google client against a mocked fetch ----------
const gcfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://app.test/api/integrations/oauth/google_sheets/callback" };
test("Google auth URL: PKCE, offline access, minimal scopes, no password fields", () => {
  const u = new URL(googleAuthUrl(gcfg, "STATE", "verifier-verifier-verifier-verifier-verifier-1234"));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("state"), "STATE");
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/spreadsheets");
  assert.ok(!u.search.includes("secret") && !u.search.includes("verifier-verifier"));
});
test("Google token exchange / refresh; invalid_grant becomes auth_expired", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push([url, String(init.body)]); return res(200, { access_token: "AT", refresh_token: "RT", expires_in: 3599, id_token: "x.y.z" }); };
  const t = await googleExchangeCode(gcfg, "CODE", "VER", { fetchImpl: f, sleep: noSleep });
  assert.equal(t.accessToken, "AT"); assert.equal(t.refreshToken, "RT");
  assert.match(seen[0][1], /grant_type=authorization_code/); assert.match(seen[0][1], /code_verifier=VER/);
  await assert.rejects(googleRefresh(gcfg, "RT", { fetchImpl: async () => res(400, { error: "invalid_grant" }), sleep: noSleep }), (e) => e.code === "auth_expired");
});
test("Google driver: append uses RAW + INSERT_ROWS, quotes sheet names, parses the first row", async () => {
  const seen = [];
  const f = async (url, init = {}) => { seen.push([url, init.method ?? "GET", init.body]); return res(200, { updates: { updatedRange: "'My Sheet'!A7:C8" } }); };
  const d = googleDriver("TOKEN", "sid", "My Sheet", { fetchImpl: f, sleep: noSleep });
  const r = await d.append([["a", 1], ["b", 2]]);
  assert.equal(r.firstRow, 7);
  assert.match(seen[0][0], /valueInputOption=RAW/); assert.match(seen[0][0], /insertDataOption=INSERT_ROWS/);
  assert.match(seen[0][0], /values\/'My%20Sheet'!A1:append/);
  assert.equal(JSON.parse(seen[0][2]).values.length, 2);
});
test("Google driver: reads headers and the id column", async () => {
  const f = async (url) => res(200, url.includes("COLUMNS") ? { values: [["id1", "id2"]] } : { values: [["Invoice No", "AI Asis ID"]] });
  const d = googleDriver("T", "sid", "S", { fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await d.readHeaders(), ["Invoice No", "AI Asis ID"]);
  assert.deepEqual(await d.readColumn(1), ["id1", "id2"]);
});

// ---------- Microsoft client against a mocked fetch ----------
const mcfg = { clientId: "mid", clientSecret: "msec", redirectUri: "https://app.test/api/integrations/oauth/microsoft_excel/callback", tenant: "common" };
test("Microsoft auth URL: PKCE, offline_access, only Files.ReadWrite for files", () => {
  const u = new URL(microsoftAuthUrl(mcfg, "S", "v".repeat(64)));
  assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const scopes = u.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes("offline_access") && scopes.includes("https://graph.microsoft.com/Files.ReadWrite"));
  assert.ok(!scopes.filter((s) => s.startsWith("https://")).some((s) => /\.All|Sites|Mail\.|Directory/i.test(s)), "no broad scopes");
  assert.equal(MICROSOFT_SCOPES.length, 5);
});
test("Microsoft refresh returns the ROTATED refresh token; revoked grant becomes auth_expired", async () => {
  const t = await microsoftRefresh(mcfg, "OLD", { fetchImpl: async () => res(200, { access_token: "A2", refresh_token: "NEW", expires_in: 3600 }), sleep: noSleep });
  assert.equal(t.refreshToken, "NEW");
  await assert.rejects(microsoftRefresh(mcfg, "OLD", { fetchImpl: async () => res(400, { error: "invalid_grant" }), sleep: noSleep }), (e) => e.code === "auth_expired");
});
test("Microsoft search keeps only .xlsx files and escapes quotes", async () => {
  let url = "";
  const f = async (u) => { url = u; return res(200, { value: [{ id: "1", name: "A.xlsx", file: {} }, { id: "2", name: "B.docx", file: {} }, { id: "3", name: "folder", folder: {} }] }); };
  const out = await msSearchWorkbooks("T", "o'brien", { fetchImpl: f, sleep: noSleep });
  assert.deepEqual(out.map((o) => o.id), ["1"]);
  assert.match(url, /o''brien|o%27%27brien/);
});
test("Microsoft table driver: rows/add with all rows in one POST; id column read from dataBodyRange", async () => {
  const seen = [];
  const f = async (url, init = {}) => { seen.push([url, init.method ?? "GET", init.body]); return res(200, url.includes("dataBodyRange") ? { values: [["x", "id9"], ["y", "id8"]] } : {}); };
  const d = microsoftDriver("T", { itemId: "it", worksheetId: "{ws}", tableId: "{tb}" }, { fetchImpl: f, sleep: noSleep });
  assert.deepEqual(await d.readColumn(1), ["id9", "id8"]);
  await d.append([["a", "b"], ["c", "d"]]);
  const post = seen.find((s) => s[1] === "POST");
  assert.match(post[0], /\/tables\/%7Btb%7D\/rows\/add$/);
  assert.equal(JSON.parse(post[2]).values.length, 2);
  assert.equal(d.guard, "excel");
});
test("Microsoft plain-sheet driver: writes below the last used row", async () => {
  const seen = [];
  const f = async (url, init = {}) => { seen.push([url, init.method ?? "GET", init.body]); return res(200, { rowIndex: 0, rowCount: 5, columnIndex: 0 }); };
  const d = microsoftDriver("T", { itemId: "it", worksheetId: "ws1", tableId: null }, { fetchImpl: f, sleep: noSleep });
  const r = await d.append([["a", "b", "c"], ["d", "e", "f"]]);
  assert.equal(r.firstRow, 6);
  const patch = seen.find((s) => s[1] === "PATCH");
  assert.match(decodeURIComponent(patch[0]), /range\(address='A6:C7'\)/);
});
