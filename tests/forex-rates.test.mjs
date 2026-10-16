import test from "node:test";
import assert from "node:assert/strict";
import { createFxLookup, plausibleRate, isIsoDate } from "../lib/extraction/fx-rates.ts";
import { resolveForex, detectBasis, convertToInr } from "../lib/extraction/forex.ts";
import { rateToleranceFor, checkLineItems } from "../lib/extraction/arithmetic.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { model, item, f, missing, minimalPdf, sha } from "./helpers.mjs";

// ---- fake network ------------------------------------------------------------------------------------------------------
// routes: { "<url prefix>": body | null (HTTP 500) | Error (network failure) }
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const v = key === undefined ? null : routes[key];
    if (v instanceof Error) throw v;
    if (v === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => v };
  };
  return { impl, calls };
}
const FRANK = "https://api.frankfurter.dev/v1/";
const CDN = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@";
const MIRROR = "https://2026-09-15.currency-api.pages.dev";
const NOW = () => Date.parse("2026-10-14T00:00:00Z");

test("fx: Frankfurter answer is used, INR per 1 unit, with source label", async () => {
  const net = fakeFetch({ [FRANK + "2026-09-15?base=USD&symbols=INR"]: { base: "USD", date: "2026-09-15", rates: { INR: 83.4123 } } });
  const r = await createFxLookup({ fetchImpl: net.impl, now: NOW })("usd", "2026-09-15");
  assert.equal(r.ok, true);
  assert.equal(r.rate.rate, 83.4123);
  assert.equal(r.rate.rateDate, "2026-09-15");
  assert.equal(r.rate.source, "frankfurter");
  assert.equal(net.calls.length, 1);
});

test("fx: a weekend invoice date uses the last working day's rate", async () => {
  const net = fakeFetch({ [FRANK]: { base: "EUR", date: "2026-09-11", rates: { INR: 97.2 } } });
  const r = await createFxLookup({ fetchImpl: net.impl, now: NOW })("EUR", "2026-09-13");
  assert.equal(r.ok, true);
  assert.equal(r.rate.requestedDate, "2026-09-13");
  assert.equal(r.rate.rateDate, "2026-09-11");
});

test("fx: falls back to currency-api, then to its mirror", async () => {
  const body = { date: "2026-09-15", usd: { inr: 83.1 } };
  let net = fakeFetch({ [FRANK]: null, [CDN]: body });
  let r = await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15");
  assert.equal(r.ok && r.rate.source, "currency-api");
  net = fakeFetch({ [FRANK]: new Error("down"), [CDN]: null, [MIRROR]: body });
  r = await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15");
  assert.equal(r.ok && r.rate.source, "currency-api-mirror");
  assert.equal(r.rate.rate, 83.1);
});

test("fx: everything down gives unavailable, never a guess", async () => {
  const net = fakeFetch({});
  const r = await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15");
  assert.deepEqual(r, { ok: false, reason: "unavailable" });
});

test("fx: implausible rate (wrong unit), later date and stale date are rejected", async () => {
  let net = fakeFetch({ [FRANK]: { date: "2026-09-15", rates: { INR: 0.012 } }, [CDN]: null, [MIRROR]: null });
  assert.deepEqual(await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15"), { ok: false, reason: "implausible" });
  net = fakeFetch({ [FRANK]: { date: "2026-09-16", rates: { INR: 83 } }, [CDN]: null, [MIRROR]: null }); // after the invoice date
  assert.equal((await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15")).ok, false);
  net = fakeFetch({ [FRANK]: { date: "2026-08-01", rates: { INR: 83 } }, [CDN]: null, [MIRROR]: null }); // 45 days old
  assert.equal((await createFxLookup({ fetchImpl: net.impl, now: NOW })("USD", "2026-09-15")).ok, false);
});

test("fx: bad input never reaches the network", async () => {
  const net = fakeFetch({});
  const look = createFxLookup({ fetchImpl: net.impl, now: NOW });
  assert.equal((await look("INR", "2026-09-15")).reason, "unsupported_currency");
  assert.equal((await look("US", "2026-09-15")).reason, "unsupported_currency");
  assert.equal((await look("USD", "15-09-2026")).reason, "bad_date");
  assert.equal((await look("USD", "2026-02-31")).reason, "bad_date");
  assert.equal((await look("USD", "2027-01-01")).reason, "future_date");
  assert.equal((await look("USD", "1990-01-01")).reason, "too_old");
  assert.equal(net.calls.length, 0);
  assert.equal(isIsoDate("2026-09-15"), true);
  assert.equal(plausibleRate("USD", 83), true);
  assert.equal(plausibleRate("USD", 0), false);
});

test("fx: second lookup of the same day does not fetch again; persistent cache is used and written", async () => {
  const net = fakeFetch({ [FRANK]: { date: "2026-09-15", rates: { INR: 83.4 } } });
  const stored = new Map();
  const cache = { get: async (c, d) => stored.get(`${c}|${d}`) ?? null, set: async (r) => void stored.set(`${r.currency}|${r.requestedDate}`, r) };
  const a = createFxLookup({ fetchImpl: net.impl, now: NOW, cache });
  await a("USD", "2026-09-15");
  await a("USD", "2026-09-15");
  assert.equal(net.calls.length, 1);
  assert.equal(stored.size, 1);
  const net2 = fakeFetch({});
  const r = await createFxLookup({ fetchImpl: net2.impl, now: NOW, cache })("USD", "2026-09-15"); // new instance: cache hit
  assert.equal(r.ok && r.rate.rate, 83.4);
  assert.equal(net2.calls.length, 0);
  const broken = { get: async () => { throw new Error("db"); }, set: async () => { throw new Error("db"); } };
  assert.equal((await createFxLookup({ fetchImpl: net.impl, now: NOW, cache: broken })("USD", "2026-09-15")).ok, true);
});

// ---- resolveForex -------------------------------------------------------------------------------------------------------
const ref = (rate, over = {}) => async (c, d) => ({ ok: true, rate: { currency: c, rate, requestedDate: d, rateDate: d, source: "frankfurter", sourceLabel: "ECB reference rate via Frankfurter", ...over } });
const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };

// USD invoice. Unit prices in USD, taxable values in INR at 83.50 (see forex-arithmetic.test.mjs).
const line1 = (o = {}) => item({ description: f("Machine"), quantity: f(5), unit_price: f(1200), discount: f(100), taxable_value: f(492650), gst_rate: f(18), tax_amount: f(88677), line_total: f(581327), ...o });
const line2 = (o = {}) => item({ description: f("Spares"), quantity: f(2), unit_price: f(300), discount: missing(), taxable_value: f(50100), gst_rate: f(18), tax_amount: f(9018), line_total: f(59118), ...o });
const usd = (over = {}) => model({
  currency: f("USD"), buyer_gstin: missing(), place_of_supply: f("United States"), // an export invoice prints a place of supply outside India (not a Maharashtra state code), so the state rule does not apply
  taxable_value: f(542750), cgst: missing(), sgst: missing(), igst: f(97695), cess: f(5427.5), grand_total: f(645872.5),
  line_items: [line1(), line2()], ...over,
});
const norm = (m) => normalizeExtraction(m, { model: "m", now: new Date("2026-10-11") });

test("forex: INR invoices are untouched", async () => {
  const { extracted, items } = norm(model());
  const r = await resolveForex(extracted, items, ref(83), OPTS);
  assert.equal(r.summary, null);
  assert.deepEqual(r.flags, []);
  assert.equal(r.exchangeRate, null);
});

test("forex: printed rate is kept; a rate close to the reference raises no flag", async () => {
  const { extracted, items } = norm(usd({ exchange_rate: f(83.5) }));
  const r = await resolveForex(extracted, items, ref(83.1), OPTS);
  assert.equal(r.exchangeRate, null); // never replaced
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.rate_origin, "printed");
  assert.equal(r.summary.rate, 83.5);
  assert.equal(r.summary.reference_rate, 83.1);
});

test("forex: a printed rate far from the reference (misread digit) is a warning", async () => {
  const { extracted, items } = norm(usd({ exchange_rate: f(38.5) }));
  const r = await resolveForex(extracted, items, ref(83.1), OPTS);
  const w = r.flags.find((x) => x.code === "forex_rate_differs_from_reference");
  assert.ok(w);
  assert.equal(w.severity, "warning");
  assert.equal(r.exchangeRate, null);
});

test("forex: lines that agree on one rate are used with the strict check; reference is only a cross-check", async () => {
  const { extracted, items } = norm(usd()); // no printed rate; both lines convert at 83.50
  const r = await resolveForex(extracted, items, ref(83.1), OPTS);
  assert.equal(r.summary.rate_origin, "from_lines");
  assert.equal(r.exchangeRate, 83.5);
  assert.equal(r.fieldMeta.source, "computed");
  assert.ok(r.flags.some((x) => x.code === "forex_rate_from_lines" && x.severity === "info"));
  assert.ok(!r.flags.some((x) => x.code === "forex_rate_differs_from_reference"));
});

test("forex: no printed rate and amounts still in USD -> reference rate fetched, INR total calculated", async () => {
  // 5 x 1200 - 100 = 5900, 2 x 300 = 600 -> taxable USD 6500, IGST 18% 1170, total 7670
  const m = usd({
    line_items: [line1({ taxable_value: f(5900), tax_amount: f(1062), line_total: f(6962) }), line2({ taxable_value: f(600), tax_amount: f(108), line_total: f(708) })],
    taxable_value: f(6500), igst: f(1170), cess: missing(), grand_total: f(7670),
  });
  const { extracted, items } = norm(m);
  const r = await resolveForex(extracted, items, ref(83.25), OPTS);
  assert.equal(r.exchangeRate, 83.25);
  assert.deepEqual(r.fieldMeta, { state: "value", confidence: 1, source: "fetched" });
  assert.equal(r.summary.rate_origin, "fetched");
  assert.equal(r.summary.conversion.basis, "invoice_currency");
  assert.equal(r.summary.conversion.taxable_inr, 541125); // 6500 x 83.25
  assert.equal(r.summary.conversion.total_inr, 638527.5); // 7670 x 83.25
  const info = r.flags.find((x) => x.code === "forex_rate_auto_fetched");
  assert.equal(info.severity, "info");
  assert.match(info.message, /83\.25/);
  assert.match(info.message, /638527\.50/);
});

test("forex: nothing is guessed when the lookup fails or the date is missing", async () => {
  const m = usd({ line_items: [line1({ taxable_value: f(5900) })], taxable_value: f(5900) });
  const { extracted, items } = norm(m);
  const r = await resolveForex(extracted, items, async () => ({ ok: false, reason: "unavailable" }), OPTS);
  assert.equal(r.exchangeRate, null);
  assert.equal(r.flags[0].code, "forex_rate_unavailable");
  assert.equal(r.flags[0].severity, "info");
  const noDate = { ...extracted, invoice_date: null };
  const r2 = await resolveForex(noDate, items, ref(83), OPTS);
  assert.equal(r2.exchangeRate, null);
  assert.equal(r2.flags[0].code, "forex_rate_unavailable");
});

test("forex: detectBasis and convertToInr", () => {
  const { extracted, items } = norm(usd({ exchange_rate: f(83.5) }));
  assert.equal(detectBasis(items, 83.5, 100, 0.0005), "inr");
  const c = convertToInr(extracted, "inr", 83.5);
  assert.equal(c.total_inr, 645872.5);
  assert.equal(c.total_foreign, 7735); // 645,872.50 / 83.5
  assert.equal(convertToInr(extracted, "unknown", 83.5).total_inr, null);
});

// ---- wider tolerance only for a FETCHED rate ----------------------------------------------------------------------------
test("tolerance: wide for a fetched rate, strict for a printed one", () => {
  assert.equal(rateToleranceFor({ exchange_rate: { source: "fetched" } }), 0.03);
  assert.equal(rateToleranceFor({ exchange_rate: { source: "recheck" } }), 0.0005);
  assert.equal(rateToleranceFor({}), 0.0005);
  // 5 x 1200 - 100 = 5900 USD. Supplier used 83.50 -> 492,650.00. Reference rate 83.00 -> 489,700.00 (0.6 % apart).
  const it = [{ description: "x", hsn_code: null, quantity: 5, unit: null, unit_price: 1200, discount_amount: 100, taxable_amount: 492650, gst_rate: 18, gst_amount: null, line_total: null, field_status: {} }];
  const base = { currency: "USD", exchangeRate: 83, tolerancePaise: 100 };
  assert.equal(checkLineItems(it, base).length, 1); // strict: flagged
  assert.deepEqual(checkLineItems(it, { ...base, rateTolerance: 0.03, rateFetched: true }), []); // fetched: accepted
  const far = [{ ...it[0], taxable_amount: 530000 }]; // 7 % off: still flagged with the wide tolerance
  assert.equal(checkLineItems(far, { ...base, rateTolerance: 0.03, rateFetched: true }).length, 1);
});

// ---- whole pipeline -----------------------------------------------------------------------------------------------------
async function runPipeline(m, fx) {
  const pdf = minimalPdf(1);
  const cfg = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: false };
  const saved = [];
  let t = Date.parse("2026-10-11T00:00:00Z");
  const res = { ok: true, text: JSON.stringify(m), usage: { inputTokens: 10, outputTokens: 10 } };
  const deps = {
    geminiConfig: cfg, maxPdfPages: 10, now: () => (t += 500), sleep: async () => {}, random: () => 0, log: () => {}, fx,
    files: { download: async () => pdf }, gemini: async () => res,
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { saved.push(a); return "ok"; } },
  };
  const r = await runExtraction(deps, { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) });
  return { r, ex: saved[0]?.extracted, items: saved[0]?.items };
}
const usdAmountsInUsd = () => usd({
  line_items: [line1({ taxable_value: f(5900), tax_amount: f(1062), line_total: f(6962) }), line2({ taxable_value: f(600), tax_amount: f(108), line_total: f(708) })],
  taxable_value: f(6500), igst: f(1170), cess: missing(), grand_total: f(7670),
});

test("pipeline: USD invoice without a printed rate gets the reference rate, saved as fetched, and passes the checks", async () => {
  const { r, ex } = await runPipeline(usdAmountsInUsd(), ref(83.25));
  assert.equal(r.outcome, "completed", JSON.stringify(ex?.review_flags.map((x) => [x.code, x.severity])));
  assert.equal(ex.exchange_rate, 83.25);
  assert.equal(ex.field_status.exchange_rate.source, "fetched");
  assert.equal(ex.validation_summary.forex.rate_origin, "fetched");
  assert.equal(ex.validation_summary.forex.conversion.total_inr, 638527.5);
  assert.ok(ex.review_flags.some((x) => x.code === "forex_rate_auto_fetched"));
  assert.ok(!ex.review_flags.some((x) => x.code === "forex_rate_unverified"));
});

test("pipeline: INR-converted lines (supplier rate 83.50) and a fetched rate 0.6 % away pass, a rate 12 % away is flagged", async () => {
  const one = (o = {}) => usd({ line_items: [line1({ ...o })], taxable_value: f(492650), igst: f(88677), cess: missing(), grand_total: f(581327) });
  const ok = await runPipeline(one(), ref(83)); // single line: no agreement between lines, so the reference rate is used
  assert.equal(ok.ex.exchange_rate, 83);
  assert.ok(!ok.ex.review_flags.some((x) => x.code === "arithmetic_line_mismatch"), JSON.stringify(ok.ex.review_flags.map((x) => x.code)));
  const bad = await runPipeline(one(), ref(93.5));
  assert.ok(bad.ex.review_flags.some((x) => x.code === "arithmetic_line_mismatch"));
  assert.equal(bad.r.outcome, "needs_review");
});

test("pipeline: printed rate is never replaced by the fetched one", async () => {
  const { ex } = await runPipeline(usd({ exchange_rate: f(83.5) }), ref(83.1));
  assert.equal(ex.exchange_rate, 83.5);
  assert.notEqual(ex.field_status.exchange_rate?.source, "fetched");
  assert.equal(ex.validation_summary.forex.reference_rate, 83.1);
});

test("pipeline: without fx (or when the lookup throws) nothing changes", async () => {
  const a = await runPipeline(usd(), null);
  assert.equal(a.ex.validation_summary.forex, undefined);
  const b = await runPipeline(usd(), async () => { throw new Error("boom"); });
  assert.equal(b.r.outcome === "failed", false);
  assert.equal(b.ex.validation_summary.forex, undefined);
});

test("pipeline: INR invoice never calls the lookup", async () => {
  let called = 0;
  await runPipeline(model(), async () => { called += 1; return { ok: false, reason: "unavailable" }; });
  assert.equal(called, 0);
});

test("review re-check after an edit keeps the wide tolerance for a fetched rate", () => {
  const { extracted, items } = norm(usd());
  const h = { ...Object.fromEntries(HEADER_COLUMNS.map((c) => [c, extracted[c] ?? null])), exchange_rate: 83 }; // the rate is an editable header value
  const fs = { ...extracted.field_status, exchange_rate: { state: "value", confidence: 1, source: "fetched" } };
  const flags = computeReviewFlags(h, fs, items, OPTS, new Date("2026-10-11"), { exchange_rate: 83 });
  assert.deepEqual(flags.filter((x) => x.code === "arithmetic_line_mismatch"), []);
  const strict = computeReviewFlags(h, { ...fs, exchange_rate: { state: "value", confidence: 1, source: "human" } }, items, OPTS, new Date("2026-10-11"), { exchange_rate: 83 });
  assert.ok(strict.some((x) => x.code === "arithmetic_line_mismatch"));
});
