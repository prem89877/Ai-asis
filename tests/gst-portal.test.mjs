// GST portal verification and vendor fraud warnings (lib/extraction/gst-portal.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { assessSupplier, checkSupplierOnPortal, clearGstPortalCache, createGstinApiLookup, getGstPortalConfig, parseGstinApi } from "../lib/extraction/gst-portal.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { f, minimalPdf, model, sha } from "./helpers.mjs";

const GSTIN = "27AAPFU0939F1ZV"; // valid layout and check digit (same one the shared test model uses)
const rec = (over = {}) => ({ gstin: GSTIN, legalName: "ACME TRADERS PRIVATE LIMITED", tradeName: "ACME TRADERS", status: "active", statusText: "Active", taxpayerType: "Regular", registrationDate: "2018-04-01", cancellationDate: null, blocked: false, ...over });
const inv = (over = {}) => ({ vendor_name: "Acme Traders", invoice_date: "2026-09-15", cgst_amount: 90, sgst_amount: 90, igst_amount: null, document_type: "tax_invoice", ...over });
const codes = (r) => r.flags.map((x) => x.code);

test("active supplier, active on the invoice date: only an info 'verified' note", () => {
  const r = assessSupplier(rec(), inv());
  assert.deepEqual(codes(r), ["supplier_gstin_verified"]);
  assert.equal(r.flags[0].severity, "info");
  assert.equal(r.summary.active_on_invoice_date, true);
  assert.equal(r.summary.name_match, true);
});

test("cancelled BEFORE the invoice date: vendor fraud warning (error)", () => {
  const r = assessSupplier(rec({ status: "cancelled", statusText: "Cancelled", cancellationDate: "2026-03-31" }), inv());
  assert.deepEqual(codes(r), ["supplier_gstin_cancelled"]);
  assert.equal(r.flags[0].severity, "error");
  assert.match(r.flags[0].message, /Vendor fraud warning/);
  assert.equal(r.summary.active_on_invoice_date, false);
});

test("cancelled AFTER the invoice date: it was active then, info only", () => {
  const r = assessSupplier(rec({ status: "cancelled", statusText: "Cancelled", cancellationDate: "2026-10-01" }), inv());
  assert.deepEqual(codes(r), ["supplier_gstin_cancelled_later"]);
  assert.equal(r.flags[0].severity, "info");
  assert.equal(r.summary.active_on_invoice_date, true);
});

test("cancelled on the invoice date itself counts as cancelled", () => {
  const r = assessSupplier(rec({ status: "cancelled", statusText: "Cancelled", cancellationDate: "2026-09-15" }), inv());
  assert.deepEqual(codes(r), ["supplier_gstin_cancelled"]);
});

test("cancelled with no cancellation date on the portal: error, date test not possible", () => {
  const r = assessSupplier(rec({ status: "cancelled", statusText: "Cancelled" }), inv());
  assert.deepEqual(codes(r), ["supplier_gstin_cancelled"]);
  assert.equal(r.summary.active_on_invoice_date, null);
});

test("registered AFTER the invoice date: vendor fraud warning", () => {
  const r = assessSupplier(rec({ registrationDate: "2026-11-01" }), inv());
  assert.ok(codes(r).includes("supplier_gstin_not_yet_registered"));
  assert.equal(r.flags.find((x) => x.code === "supplier_gstin_not_yet_registered").severity, "error");
  assert.equal(r.summary.active_on_invoice_date, false);
  assert.ok(!codes(r).includes("supplier_gstin_verified"));
});

test("suspended supplier: warning; blocked supplier: warning", () => {
  assert.deepEqual(codes(assessSupplier(rec({ status: "suspended", statusText: "Suspended" }), inv())), ["supplier_gstin_inactive"]);
  assert.ok(codes(assessSupplier(rec({ blocked: true }), inv())).includes("supplier_gstin_blocked"));
});

test("name on the invoice differs from the registered names: warning; 'Pvt Ltd' variants are fine", () => {
  assert.ok(codes(assessSupplier(rec(), inv({ vendor_name: "Zenith Enterprises" }))).includes("supplier_name_mismatch"));
  assert.ok(!codes(assessSupplier(rec(), inv({ vendor_name: "Acme Traders Pvt Ltd" }))).includes("supplier_name_mismatch"));
});

test("composition dealer charging GST on a tax invoice: warning; no tax charged: fine", () => {
  assert.ok(codes(assessSupplier(rec({ taxpayerType: "Composition" }), inv())).includes("composition_charging_tax"));
  assert.ok(!codes(assessSupplier(rec({ taxpayerType: "Composition" }), inv({ cgst_amount: null, sgst_amount: null, document_type: "bill_of_supply" }))).includes("composition_charging_tax"));
});

test("no invoice date: status is still checked, 'active on the date' stays undecided", () => {
  const r = assessSupplier(rec(), inv({ invoice_date: null }));
  assert.equal(r.summary.active_on_invoice_date, null);
  assert.deepEqual(codes(r), ["supplier_gstin_verified"]);
});

test("parseGstinApi reads the documented answer and rejects other shapes", () => {
  const body = { success: true, gstin: GSTIN, data: { legal_name: "ACME", trade_name: null, status: "Cancelled", taxpayer_type: "Regular", registration_date: "2020-01-01", cancellation_date: "2024-05-01", block_status: "B" } };
  const r = parseGstinApi(body, GSTIN);
  assert.equal(r.status, "cancelled");
  assert.equal(r.cancellationDate, "2024-05-01");
  assert.equal(r.blocked, true);
  assert.equal(parseGstinApi({ success: false }, GSTIN), null);
  assert.equal(parseGstinApi({ success: true, data: {} }, GSTIN), null);
  assert.equal(parseGstinApi("x", GSTIN), null);
});

test("config: needs an API key, can be switched off, base URL and limits are clamped", () => {
  assert.equal(getGstPortalConfig({}), null);
  assert.equal(getGstPortalConfig({ GST_PORTAL_API_KEY: "k", GST_PORTAL_CHECK: "off" }), null);
  const c = getGstPortalConfig({ GST_PORTAL_API_KEY: "k", GST_PORTAL_BASE_URL: "https://x.test/", GST_PORTAL_TIMEOUT_MS: "999999" });
  assert.equal(c.baseUrl, "https://x.test");
  assert.equal(c.timeoutMs, 20000);
  assert.equal(c.cacheMinutes, 60);
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const CFG = { apiKey: "gak_k", baseUrl: "https://gstinapi.in", timeoutMs: 5000, cacheMinutes: 60 };
const okBody = { success: true, gstin: GSTIN, data: { legal_name: "ACME TRADERS PRIVATE LIMITED", trade_name: "ACME TRADERS", status: "Active", taxpayer_type: "Regular", registration_date: "2018-04-01", cancellation_date: null } };

test("lookup: right URL and header, answers cached so the same GSTIN costs one call", async () => {
  clearGstPortalCache();
  const ff = fakeFetch(() => json(200, okBody));
  const lookup = createGstinApiLookup(CFG, ff);
  const a = await lookup(GSTIN, { timeoutMs: 5000 });
  const b = await lookup(GSTIN, { timeoutMs: 5000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(ff.calls.length, 1);
  assert.equal(ff.calls[0].url, `https://gstinapi.in/v1/gstin/${GSTIN}`);
  assert.equal(ff.calls[0].init.headers["x-api-key"], "gak_k");
});

test("lookup: 404 = not found, 402 = no credits, 429, 502 and a thrown error are 'unavailable' kinds, never a crash", async () => {
  clearGstPortalCache();
  const code = async (h) => (await createGstinApiLookup({ ...CFG, cacheMinutes: 0 }, fakeFetch(h))(GSTIN, { timeoutMs: 100 })).code;
  assert.equal(await code(() => json(404, {})), "not_found");
  assert.equal(await code(() => json(402, {})), "no_credits");
  assert.equal(await code(() => json(429, {})), "rate_limited");
  assert.equal(await code(() => json(502, {})), "unavailable");
  assert.equal(await code(() => { throw new Error("net"); }), "unavailable");
  assert.equal(await code(() => json(200, { success: true, data: {} })), "bad_response");
});

test("checkSupplierOnPortal: invalid GSTIN is never sent; not found = error; service down = info only", async () => {
  const never = async () => { throw new Error("must not be called"); };
  assert.equal((await checkSupplierOnPortal(never, { vendor_gstin: "27AAPFU0939F1ZX" }, { timeoutMs: 1000 })).lookedUp, false); // bad check digit
  assert.equal((await checkSupplierOnPortal(never, { vendor_gstin: null }, { timeoutMs: 1000 })).lookedUp, false);
  const e = { ...inv(), vendor_gstin: GSTIN };
  const nf = await checkSupplierOnPortal(async () => ({ ok: false, code: "not_found" }), e, { timeoutMs: 1000 });
  assert.deepEqual(nf.flags.map((x) => [x.code, x.severity]), [["supplier_gstin_not_found", "error"]]);
  const down = await checkSupplierOnPortal(async () => ({ ok: false, code: "timeout" }), e, { timeoutMs: 1000 });
  assert.deepEqual(down.flags.map((x) => [x.code, x.severity]), [["gst_portal_unavailable", "info"]]);
  assert.equal(down.summary.checked, false);
});

// ---- End to end through runExtraction --------------------------------------------------------------------------------------
async function run(gstPortal) {
  const pdf = minimalPdf();
  const completes = [];
  const deps = {
    geminiConfig: { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 1, maxOutputTokens: 1000, verify: false, audit: false, totalCheck: false, partiesCheck: false },
    gstPortal, maxPdfPages: 10, now: () => Date.parse("2026-10-11T00:00:00Z"), sleep: async () => {}, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async () => ({ ok: true, text: JSON.stringify(model({ supplier_name: f("Acme Traders") })), usage: { inputTokens: 1, outputTokens: 1 } }),
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { completes.push(a); return "ok"; } },
  };
  const r = await runExtraction(deps, { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) });
  return { r, saved: completes[0] };
}

test("pipeline: cancelled supplier => needs_review with the fraud warning and the portal summary saved", async () => {
  const { r, saved } = await run(async () => ({ ok: true, record: rec({ status: "cancelled", statusText: "Cancelled", cancellationDate: "2026-01-10" }) }));
  assert.equal(r.outcome, "needs_review");
  assert.ok(saved.extracted.review_flags.some((x) => x.code === "supplier_gstin_cancelled" && x.severity === "error"));
  assert.equal(saved.extracted.validation_summary.gst_portal.active_on_invoice_date, false);
  assert.equal(saved.extracted.validation_summary.gst_portal.status, "Cancelled");
});

test("pipeline: active supplier keeps the invoice 'completed'; a failing or missing portal never blocks extraction", async () => {
  assert.equal((await run(async () => ({ ok: true, record: rec() }))).r.outcome, "completed");
  const down = await run(async () => ({ ok: false, code: "unavailable" }));
  assert.equal(down.r.outcome, "completed");
  assert.ok(down.saved.extracted.review_flags.some((x) => x.code === "gst_portal_unavailable"));
  assert.equal((await run(async () => { throw new Error("boom"); })).r.outcome, "completed");
  assert.equal((await run(null)).r.outcome, "completed");
});
