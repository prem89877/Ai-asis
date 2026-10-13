// The blind parties reading (supplier / buyer GSTIN, PAN, state, every printed GSTIN), GSTIN retries and the final three-layer gate
// inside the pipeline. The provider is a stub; nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { PARTIES_SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { getGeminiConfig } from "../lib/extraction/config.ts";
import { gstinChecksumChar } from "../lib/extraction/normalize.ts";
import { model, minimalPdf, sha, f } from "./helpers.mjs";

const pdf = minimalPdf();
const WORDS = "Rupees One Thousand One Hundred Eighty Only";
const SUP = "27AAPFU0939F1ZV"; // the supplier GSTIN used by helpers.model()
const BUY = "29ABCDE1234F1Z" + gstinChecksumChar("29ABCDE1234F1Z");
const baseCfg = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true, audit: true, totalCheck: true, partiesCheck: true, partiesRetries: 1 };
const swap = (g, i, c) => g.slice(0, i) + c + g.slice(i + 1);

function setup(responses, config = {}) {
  const calls = { gemini: [], usage: [], completes: [] };
  let t = Date.parse("2026-10-11T00:00:00Z");
  const deps = {
    geminiConfig: { ...baseCfg, ...config }, maxPdfPages: 10, now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async (input) => {
      const r = responses[Math.min(calls.gemini.length, responses.length - 1)];
      calls.gemini.push(input);
      t += 1000;
      return r;
    },
    store: {
      recordUsage: async (u) => { calls.usage.push(u); },
      findDuplicateCandidates: async () => [],
      complete: async (a) => { calls.completes.push(a); return "ok"; },
    },
  };
  const ctx = { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) };
  return { deps, ctx, calls };
}
const ok = (m) => ({ ok: true, text: JSON.stringify(m), usage: { inputTokens: 100, outputTokens: 50 } });
const down = { ok: false, code: "provider_unavailable", retryable: true };
const saved = (calls) => calls.completes[0].extracted;
const flagOf = (e, code) => e.review_flags.filter((x) => x.code === code);
const good = (over = {}) => model({ amount_in_words: f(WORDS), buyer_gstin: f(BUY), ...over });
const parties = (over = {}) => ({
  supplier_name: f("Acme Traders"), supplier_gstin: f(SUP), supplier_pan: f(SUP.slice(2, 12)), supplier_state: f("Maharashtra, Code: 27"),
  buyer_name: f("Beta Stores"), buyer_gstin: f(BUY), place_of_supply: f("Maharashtra (27)"),
  printed_gstins: [{ value: SUP, role: "supplier", label: "GSTIN/UIN:" }, { value: BUY, role: "buyer", label: "Bill to" }], ...over,
});

test("the parties layer is on by default, has its own switch and its own retry count", () => {
  const c = getGeminiConfig({ GEMINI_API_KEY: "k" });
  assert.equal(c.partiesCheck, true);
  assert.equal(c.partiesRetries, 1);
  const off = getGeminiConfig({ GEMINI_API_KEY: "k", EXTRACTION_PARTIES_CHECK: "off", EXTRACTION_PARTIES_RETRIES: "9" });
  assert.equal(off.partiesCheck, false);
  assert.equal(off.partiesRetries, 3);
});

test("five readings: the parties reading is blind, small and uses its own prompt and schema", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good()), ok(parties())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(calls.gemini.length, 5);
  assert.deepEqual(calls.usage.map((u) => u.outcome), ["ok", "parties_ok", "verify_ok", "audit_ok", "keyfigures_ok"]);
  assert.equal(calls.gemini[4].systemPrompt, PARTIES_SYSTEM_PROMPT);
  assert.ok(!/first_reading/.test(calls.gemini[4].userPrompt));
  assert.deepEqual(calls.gemini[4].responseSchema.required, ["supplier_gstin", "buyer_gstin", "printed_gstins"]);
  const e = saved(calls);
  assert.equal(e.vendor_gstin, SUP);
  assert.equal(e.buyer_gstin, BUY);
  const v = e.validation_summary.verification;
  assert.equal(v.passed, true);
  assert.equal(v.complete, true);
  assert.equal(v.layers.length, 3);
  assert.equal(v.fields.supplier_gstin.status, "verified");
  assert.equal(v.gstin.supplier_gstin.status, "verified");
  assert.equal(v.gstin.buyer_gstin.status, "verified");
  assert.equal(e.review_flags.filter((x) => x.severity !== "info").length, 0);
});

test("a GSTIN character misread in the first reading is fixed by the other readings and the result is verified", async () => {
  const bad = swap(SUP, 5, "P");
  const { deps, ctx, calls } = setup([ok(good({ supplier_gstin: f(bad) })), ok(good()), ok(good()), ok(good()), ok(parties())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(saved(calls).vendor_gstin, SUP);
  assert.equal(saved(calls).validation_summary.verification.fields.supplier_gstin.status, "verified");
});

test("three readings each wrong in a different character: the character vote rebuilds the GSTIN and says so", async () => {
  const { deps, ctx, calls } = setup([
    ok(good({ supplier_gstin: f(swap(SUP, 3, "B")) })),
    ok(good({ supplier_gstin: f(swap(SUP, 8, "8")) })),
    ok(good({ supplier_gstin: f(swap(SUP, 6, "V")) })),
    ok(good()),
    ok(parties({ supplier_gstin: f(swap(SUP, 10, "0")) })),
  ], { partiesRetries: 0 });
  await runExtraction(deps, ctx);
  const e = saved(calls);
  assert.equal(e.vendor_gstin, SUP);
  assert.equal(flagOf(e, "gstin_char_voted").length, 1);
  assert.equal(flagOf(e, "gstin_char_voted")[0].severity, "info");
});

test("supplier and buyer GSTIN swapped in the readings are put back, with a warning", async () => {
  const sw = { supplier_gstin: f(BUY), buyer_gstin: f(SUP) };
  const { deps, ctx, calls } = setup([ok(good(sw)), ok(good(sw)), ok(good()), ok(good()), ok(parties())]);
  const r = await runExtraction(deps, ctx);
  const e = saved(calls);
  assert.equal(e.vendor_gstin, SUP);
  assert.equal(e.buyer_gstin, BUY);
  assert.equal(flagOf(e, "gstin_roles_swapped").length, 1);
  assert.equal(r.outcome, "needs_review");
});

test("the printed PAN contradicts the GSTIN: gstin_conflict warning and the invoice goes to review", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good()), ok(parties({ supplier_pan: f("ZZZZZ9999Z") }))]);
  const r = await runExtraction(deps, ctx);
  const e = saved(calls);
  assert.equal(r.outcome, "needs_review");
  assert.equal(flagOf(e, "gstin_conflict").length, 1);
  assert.equal(e.validation_summary.verification.passed, false);
  assert.equal(e.validation_summary.verification.fields.supplier_gstin.status, "needs_review");
});

test("a GSTIN that is not verified triggers one extra parties reading, and it counts as one more witness", async () => {
  // First pass has no PAN / list evidence for the buyer, so the buyer GSTIN stays "probable" until the retry brings it.
  const thin = parties({ buyer_gstin: { status: "missing", value: null, confidence: 0.9 }, printed_gstins: [{ value: SUP, role: "supplier", label: "GSTIN" }] });
  const { deps, ctx, calls } = setup([ok(good({ buyer_gstin: f(BUY) })), ok(good()), ok(good({ buyer_gstin: f(swap(BUY, 4, "Q")) })), ok(good({ buyer_gstin: f(BUY) })), ok(thin), ok(parties())]);
  await runExtraction(deps, ctx);
  assert.equal(calls.gemini.length, 6);
  assert.deepEqual(calls.usage.map((u) => u.outcome).slice(-1), ["parties_retry_ok"]);
  assert.equal(calls.gemini[5].systemPrompt, PARTIES_SYSTEM_PROMPT);
});

test("no extra parties reading when the GSTINs are already verified, or when retries are 0", async () => {
  const a = setup([ok(good()), ok(good()), ok(good()), ok(good()), ok(parties())]);
  await runExtraction(a.deps, a.ctx);
  assert.equal(a.calls.gemini.length, 5);
  const thin = parties({ printed_gstins: [] , supplier_pan: { status: "missing", value: null, confidence: 0.9 }, supplier_state: { status: "missing", value: null, confidence: 0.9 } });
  const b = setup([ok(good()), ok(good({ supplier_gstin: f(swap(SUP, 5, "P")) })), ok(good({ supplier_gstin: f(swap(SUP, 9, "8")) })), ok(good()), ok(thin)], { partiesRetries: 0 });
  await runExtraction(b.deps, b.ctx);
  assert.equal(b.calls.gemini.length, 5);
});

test("parties reading fails: the others are still used and an info note says what is missing", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good()), down]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(flagOf(saved(calls), "parties_unavailable").length, 1);
  assert.equal(flagOf(saved(calls), "parties_unavailable")[0].severity, "info");
  assert.equal(saved(calls).vendor_gstin, SUP);
});

test("EXTRACTION_PARTIES_CHECK off: four readings as before, GSTINs are still judged by format and check digit", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good())], { partiesCheck: false });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(calls.gemini.length, 4);
  assert.equal(saved(calls).validation_summary.verification.parties_readings, 0);
});

test("a GSTIN with an invalid layout is never passed silently: layer 1 fails and a flag is raised", async () => {
  const badLayout = "27AAPFU0939F1Z";
  const { deps, ctx, calls } = setup([ok(good({ supplier_gstin: f(badLayout) })), ok(good({ supplier_gstin: f(badLayout) })), ok(good({ supplier_gstin: f(badLayout) })), ok(good()), ok(parties({ supplier_gstin: f(badLayout) }))]);
  const r = await runExtraction(deps, ctx);
  const e = saved(calls);
  assert.equal(r.outcome, "needs_review");
  assert.ok(e.review_flags.some((x) => x.code === "invalid_gstin" && x.field === "supplier_gstin"));
  assert.equal(e.validation_summary.verification.layers[0].failed.some((x) => x.field === "supplier_gstin"), true);
});
