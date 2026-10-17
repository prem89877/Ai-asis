// Zoho Sheet / Zoho Books / TallyPrime: pure logic and mocked HTTP only. No Zoho or Tally account, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseZohoSheetId, zohoAuthUrl, zohoExchangeCode, pickTax, zohoSheetDriver, booksFindOrCreateVendor } from "../lib/integrations/zoho.ts";
import { buildBill, booksPusher } from "../lib/integrations/books.ts";
import { pushInvoices, PushRefusal } from "../lib/integrations/push-sync.ts";
import { validateTallyUrl, isPublicAddress, parseTallyReply, parseCompanies, postToTally, tallyPusher } from "../lib/integrations/tally-push.ts";
import { DEFAULT_TALLY_CONFIG } from "../lib/tally/build.ts";
import { IntegrationError } from "../lib/integrations/http.ts";

const inv = (o = {}) => ({ id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-09-01", vendor_name: "Acme Traders", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Me", buyer_gstin: null, invoice_number: "INV-1", invoice_date: "2026-09-10", place_of_supply: "27-Maharashtra", currency: "INR", document_type: null, taxable_amount: 1000, discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180, confidence: 1, review_flags: [], verified_at: "2026-09-11T00:00:00Z", ...o });
const item = (o = {}) => ({ invoice_id: "11111111-1111-4111-8111-111111111111", position: 1, description: "Widget", hsn_code: "8471", quantity: 2, unit: "NOS", unit_price: 500, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180, ...o });
const taxes = [{ id: "T-G18", name: "GST18", percentage: 18, inter: false }, { id: "T-I18", name: "IGST18", percentage: 18, inter: true }];
const ctx = { accountId: "A1", taxes };

test("parseZohoSheetId accepts a Zoho Sheet link or id and rejects other hosts", () => {
  assert.equal(parseZohoSheetId("https://sheet.zoho.in/sheet/open/abcdef1234567890xyz"), "abcdef1234567890xyz");
  assert.equal(parseZohoSheetId("abcdef1234567890xyz"), "abcdef1234567890xyz");
  assert.equal(parseZohoSheetId("https://evil.test/sheet/open/abcdef1234567890xyz"), null);
  assert.equal(parseZohoSheetId("http://sheet.zoho.in/sheet/open/abcdef1234567890xyz"), null);
  assert.equal(parseZohoSheetId(""), null);
});

test("zohoAuthUrl goes to the chosen data centre and asks for offline access", () => {
  const u = new URL(zohoAuthUrl({ clientId: "cid", clientSecret: "s", redirectUri: "https://app.test/cb" }, ["A.B", "C.D"], "in", "st"));
  assert.equal(u.origin, "https://accounts.zoho.in");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("scope"), "A.B,C.D");
});

test("zohoExchangeCode: an error inside a 200 answer is an auth problem, a good answer gives tokens", async () => {
  const mk = (body) => ({ fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }), sleep: async () => {} });
  await assert.rejects(zohoExchangeCode({ clientId: "c", clientSecret: "s", redirectUri: "r" }, "in", "x", mk({ error: "invalid_code" })), (e) => e instanceof IntegrationError && e.code === "auth_expired");
  const t = await zohoExchangeCode({ clientId: "c", clientSecret: "s", redirectUri: "r" }, "in", "x", mk({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
  assert.deepEqual([t.accessToken, t.refreshToken], ["AT", "RT"]);
});

test("pickTax: IGST for inter-state, GST group for intra-state, null when missing", () => {
  assert.equal(pickTax(taxes, 18, false).id, "T-G18");
  assert.equal(pickTax(taxes, 18, true).id, "T-I18");
  assert.equal(pickTax(taxes, 12, false), null);
});

test("buildBill: intra-state invoice with lines becomes exact lines with the GST group tax", () => {
  const r = buildBill(inv(), [item()], ctx, "V1");
  assert.equal(r.ok, true);
  assert.equal(r.bill.line_items.length, 1);
  assert.equal(r.bill.line_items[0].rate, 1000);
  assert.equal(r.bill.line_items[0].tax_id, "T-G18");
  assert.equal(r.bill.reference_number, "11111111-1111-4111-8111-111111111111");
  assert.equal(r.bill.source_of_supply, "MH");
  assert.equal(r.bill.adjustment, undefined);
});

test("buildBill: inter-state uses the IGST tax; a small round-off becomes an adjustment", () => {
  const r = buildBill(inv({ cgst_amount: null, sgst_amount: null, igst_amount: 180, total_amount: 1180.4 }), [item()], ctx, "V1");
  assert.equal(r.ok, true);
  assert.equal(r.bill.line_items[0].tax_id, "T-I18");
  assert.equal(r.bill.adjustment, 0.4);
});

test("buildBill refuses what it cannot book exactly: cess, TCS, foreign currency, missing tax, unbalanced figures, not verified", () => {
  assert.match(buildBill(inv({ cess_amount: 5 }), [item()], ctx, "V").reason, /cess/i);
  assert.match(buildBill(inv({ tcs_amount: 5 }), [item()], ctx, "V").reason, /TCS/);
  assert.match(buildBill(inv({ currency: "USD" }), [item()], ctx, "V").reason, /USD/);
  assert.match(buildBill(inv(), [item({ gst_rate: 12 })], { accountId: "A", taxes }, "V").reason, /GST 12%/);
  assert.match(buildBill(inv({ total_amount: 1300 }), [item()], ctx, "V").reason, /total/i);
  assert.match(buildBill(inv({ status: "needs_review" }), [item()], ctx, "V").reason, /verified/i);
  assert.match(buildBill(inv(), [item({ taxable_amount: 400 })], ctx, "V").reason, /line items/i);
});

test("buildBill without lines derives ONE standard rate and only when it reproduces the printed tax", () => {
  assert.equal(buildBill(inv(), [], ctx, "V").ok, true);
  assert.match(buildBill(inv({ cgst_amount: 77, sgst_amount: 77, total_amount: 1154 }), [], ctx, "V").reason, /single standard/);
});

function fakeLedger() {
  const log = { finished: [] }; const claimed = new Set();
  return { log, claim: async (id) => (claimed.has(id) ? { kind: "in_progress" } : (claimed.add(id), { kind: "claimed" })), finish: async (id, r) => { log.finished.push([id, r.status, r.code]); } };
}

test("pushInvoices: unverified skipped, same supplier invoice twice is a duplicate, refusal becomes a failed row with the reason", async () => {
  const a = inv({ id: "a" }), dup = inv({ id: "b" }), bad = inv({ id: "c", invoice_number: "INV-2" }), nv = inv({ id: "d", status: "needs_review", invoice_number: "INV-3" });
  const ledger = fakeLedger();
  const pusher = { push: async (i) => { if (i.id === "c") throw new PushRefusal("Cess is not supported."); return {}; } };
  const res = await pushInvoices({ invoices: [a, dup, bad, nv], pusher, ledger });
  assert.deepEqual(res.map((r) => r.status), ["synced", "duplicate", "failed", "not_verified"]);
  assert.equal(res[2].message, "Cess is not supported.");
  assert.deepEqual(ledger.log.finished, [["a", "synced", undefined], ["c", "failed", "not_supported"]]);
});

test("pushInvoices: an expired authorisation fails the rest of the run without calling the provider again", async () => {
  let calls = 0;
  const pusher = { push: async () => { calls++; throw new IntegrationError("auth_expired"); } };
  const res = await pushInvoices({ invoices: [inv({ id: "a" }), inv({ id: "b", invoice_number: "X2" })], pusher, ledger: fakeLedger() });
  assert.equal(calls, 1);
  assert.deepEqual(res.map((r) => r.status), ["failed", "failed"]);
});

test("booksPusher: a bill with our reference number already in Zoho is 'recovered' and nothing is created", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([init?.method ?? "GET", url]); return new Response(JSON.stringify({ code: 0, bills: [{ bill_id: "B1", reference_number: "11111111-1111-4111-8111-111111111111", total: 1180 }] }), { status: 200 }); };
  const p = booksPusher({ token: "t", region: "in", orgId: "123456", accountId: "A1", taxes, items: new Map([[inv().id, [item()]]]), opts: { fetchImpl, sleep: async () => {} } });
  assert.deepEqual(await p.push(inv()), { recovered: true });
  assert.equal(calls.length, 1);
});

function zohoFake({ total }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const m = init.method ?? "GET"; calls.push([m, url]);
    const ok = (o) => new Response(JSON.stringify({ code: 0, ...o }), { status: 200 });
    if (m === "GET" && url.includes("/bills?")) return ok({ bills: [] });
    if (m === "GET" && url.includes("/contacts?")) return ok({ contacts: [] });
    if (m === "POST" && url.includes("/contacts?")) return ok({ contact: { contact_id: "V9" } });
    if (m === "POST" && url.includes("/bills?")) return ok({ bill: { bill_id: "B9", total } });
    if (m === "DELETE") return ok({});
    throw new Error("unexpected " + m + " " + url);
  };
  return { calls, opts: { fetchImpl, sleep: async () => {} } };
}
const mkPusher = (f) => booksPusher({ token: "t", region: "in", orgId: "123456", accountId: "A1", taxes, items: new Map([[inv().id, [item()]]]), opts: f.opts });

test("booksPusher: creates the vendor and the bill when Zoho's total matches; the bill is kept", async () => {
  const f = zohoFake({ total: 1180 });
  assert.deepEqual(await mkPusher(f).push(inv()), {});
  assert.ok(f.calls.some(([m, u]) => m === "POST" && u.includes("/bills?")));
  assert.ok(!f.calls.some(([m]) => m === "DELETE"));
});

test("booksPusher: a bill whose total differs is deleted again and reported (total_mismatch)", async () => {
  const f = zohoFake({ total: 1200 });
  await assert.rejects(mkPusher(f).push(inv()), (e) => e instanceof PushRefusal && e.code === "total_mismatch" && /removed again/.test(e.message));
  assert.ok(f.calls.some(([m]) => m === "DELETE"));
});

test("booksPusher: an invoice that will be refused creates NO vendor and NO bill", async () => {
  const f = zohoFake({ total: 1180 });
  await assert.rejects(mkPusher(f).push(inv({ cess_amount: 9 })), PushRefusal);
  assert.ok(!f.calls.some(([m]) => m === "POST"));
});

test("zohoSheetDriver.append refuses duplicate or blank header names and sends ONE non-retried request", async () => {
  const calls = [];
  const sheet = (headers) => async (url, init) => {
    const body = new URLSearchParams(init.body); calls.push(body.get("method"));
    if (body.get("method") === "range.content.get") return new Response(JSON.stringify({ range_details: [{ row_details: headers }] }), { status: 200 });
    return new Response(JSON.stringify({ records: [{ row_index: 5 }] }), { status: 200 });
  };
  const bad = zohoSheetDriver("t", "in", "abcdef1234567890xyz", "S", { fetchImpl: sheet(["A", "A"]), sleep: async () => {} });
  await assert.rejects(bad.append([["1", "2"]]), (e) => e.code === "header_changed");
  calls.length = 0;
  const good = zohoSheetDriver("t", "in", "abcdef1234567890xyz", "S", { fetchImpl: sheet(["Invoice", "AI Asis ID"]), sleep: async () => {} });
  assert.deepEqual(await good.append([["INV-1", "id1"]]), { firstRow: 5 });
  assert.equal(calls.filter((c) => c === "worksheet.records.add").length, 1);
});

// ---- TallyPrime ----
test("validateTallyUrl: only public https host names are accepted", () => {
  assert.equal(validateTallyUrl("https://tally.example.com").ok, true);
  for (const bad of ["http://tally.example.com", "https://localhost", "https://127.0.0.1", "https://192.168.1.5:9000", "https://user:pw@tally.example.com", "https://tally.internal", "https://printer.local", "https://[::1]", "ftp://x.example.com", "", "not a url"]) assert.equal(validateTallyUrl(bad).ok, false, bad);
  assert.equal(validateTallyUrl(undefined).ok, false);
});

test("isPublicAddress: private, loopback, link-local and mapped addresses are refused", () => {
  for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.0.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPublicAddress(a), false, a);
  for (const a of ["8.8.8.8", "104.16.0.1", "2606:4700::1"]) assert.equal(isPublicAddress(a), true, a);
});

test("postToTally: a host that resolves to a private address is refused BEFORE any request; redirects are not followed", async () => {
  const u = validateTallyUrl("https://tally.example.com").url;
  let sent = false;
  await assert.rejects(postToTally(u, null, "<x/>", { lookupHost: async () => ["10.0.0.5"], fetchImpl: async () => { sent = true; return new Response("ok"); } }), (e) => e.code === "permission_denied");
  assert.equal(sent, false);
  await assert.rejects(postToTally(u, null, "<x/>", { lookupHost: async () => ["8.8.8.8"], fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://10.0.0.1" } }) }), (e) => e.code === "bad_request");
});

test("parseTallyReply / parseCompanies", () => {
  assert.equal(parseTallyReply("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>").ok, true);
  const bad = parseTallyReply("<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Input CGST' does not exist!</LINEERROR></RESPONSE>");
  assert.equal(bad.ok, false); assert.match(bad.detail, /does not exist/);
  assert.equal(parseTallyReply("<RESPONSE></RESPONSE>").ok, false);
  assert.deepEqual(parseCompanies("<ENVELOPE><COLLECTION><COMPANY><NAME>Acme Ltd</NAME></COMPANY></COLLECTION></ENVELOPE>"), ["Acme Ltd"]);
});

const tp = (reply, extra = {}) => tallyPusher({ url: validateTallyUrl("https://tally.example.com").url, token: "tok", config: DEFAULT_TALLY_CONFIG, transport: { lookupHost: async () => ["8.8.8.8"], fetchImpl: reply, ...extra } });

test("tallyPusher: posts one voucher with the token; a Tally error becomes a readable refusal", async () => {
  let seen;
  const ok = tp(async (url, init) => { seen = init; return new Response("<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>"); });
  assert.deepEqual(await ok.push(inv()), {});
  assert.equal(seen.headers.Authorization, "Bearer tok");
  assert.match(seen.body, /<VOUCHERNUMBER>INV-1<\/VOUCHERNUMBER>/);
  const rej = tp(async () => new Response("<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger missing</LINEERROR></RESPONSE>"));
  await assert.rejects(rej.push(inv()), (e) => e instanceof PushRefusal && e.code === "tally_rejected" && /Ledger missing/.test(e.message));
});

test("tallyPusher: a timeout is an UNCONFIRMED outcome (the user must check Tally), an invoice Tally cannot balance is refused before sending", async () => {
  const slow = tp(async () => { const e = new Error("x"); e.name = "AbortError"; throw e; });
  await assert.rejects(slow.push(inv()), (e) => e instanceof PushRefusal && e.code === "unconfirmed");
  let sent = false;
  const p = tp(async () => { sent = true; return new Response(""); });
  await assert.rejects(p.push(inv({ total_amount: 5000 })), PushRefusal);
  assert.equal(sent, false);
});

test("booksFindOrCreateVendor reuses a vendor with the same GSTIN instead of creating a second one", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push(init.method ?? "GET"); return new Response(JSON.stringify({ code: 0, contacts: [{ contact_id: "V1", contact_name: "ACME TRADERS PVT", gst_no: "27AAPFU0939F1ZV" }] }), { status: 200 }); };
  assert.equal(await booksFindOrCreateVendor("t", "in", "123456", { name: "Acme Traders", gstin: "27AAPFU0939F1ZV" }, { fetchImpl, sleep: async () => {} }), "V1");
  assert.deepEqual(calls, ["GET"]);
});
