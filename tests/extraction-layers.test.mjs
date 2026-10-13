// The extra reading layers in the pipeline: second reading, blind audit reading, blind key-figures reading, field-by-field voting
// and the grand-total cross-check. The provider is a stub; nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { AUDIT_SYSTEM_PROMPT, KEYFIGURES_SYSTEM_PROMPT, SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { getGeminiConfig } from "../lib/extraction/config.ts";
import { HEADER_AMOUNT_FIELDS } from "../lib/extraction/types.ts";
import { model, item, minimalPdf, sha, f } from "./helpers.mjs";

const pdf = minimalPdf();
const HEX = "0123456789abcdef";
const IRN = HEX.repeat(4).slice(0, 64);
const WORDS = "Rupees One Thousand One Hundred Eighty Only";
const baseCfg = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true, audit: true, totalCheck: true };

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
const loud = (e) => e.review_flags.filter((x) => x.severity !== "info" && x.code !== "missing_field");
const good = (over = {}) => model({ amount_in_words: f(WORDS), ...over });

test("layers are on by default and each has its own switch", () => {
  const c = getGeminiConfig({ GEMINI_API_KEY: "k" });
  assert.equal(c.verify && c.audit && c.totalCheck, true);
  const off = getGeminiConfig({ GEMINI_API_KEY: "k", EXTRACTION_AUDIT: "off", EXTRACTION_TOTAL_CHECK: "false" });
  assert.equal(off.audit, false);
  assert.equal(off.totalCheck, false);
  assert.equal(off.verify, true);
});

test("four layers: second reading sees the first, audit and key-figures readings are blind and use their own prompts", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(calls.gemini.length, 4);
  assert.deepEqual(calls.usage.map((u) => u.outcome), ["ok", "verify_ok", "audit_ok", "keyfigures_ok"]);
  assert.equal(calls.gemini[1].systemPrompt, VERIFY_SYSTEM_PROMPT);
  assert.match(calls.gemini[1].userPrompt, /<first_reading>/);
  assert.equal(calls.gemini[2].systemPrompt, AUDIT_SYSTEM_PROMPT);
  assert.ok(!/first_reading/.test(calls.gemini[2].userPrompt));
  assert.equal(calls.gemini[3].systemPrompt, KEYFIGURES_SYSTEM_PROMPT);
  assert.ok(!/first_reading/.test(calls.gemini[3].userPrompt));
  assert.deepEqual(calls.gemini[3].responseSchema.required, [...HEADER_AMOUNT_FIELDS]);
  assert.equal(calls.gemini[0].responseSchema, undefined);
  const e = saved(calls);
  assert.equal(loud(e).length, 0);
  assert.equal(e.field_status.grand_total.source, "recheck");
  assert.deepEqual(e.validation_summary.total_consensus.status, "confirmed");
  assert.ok(e.validation_summary.total_consensus.sources.includes("words"));
});

test("grand total misread in the first reading is corrected by the other layers, words and arithmetic", async () => {
  const { deps, ctx, calls } = setup([ok(good({ grand_total: f(1130) })), ok(good()), ok(good()), ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(saved(calls).total_amount, 1180);
  assert.equal(flagOf(saved(calls), "arithmetic_total_mismatch").length, 0);
});

test("grand total misread in TWO readings: the audit and key-figures readings plus the arithmetic outvote them", async () => {
  const { deps, ctx, calls } = setup([ok(good({ grand_total: f(1130) })), ok(good({ grand_total: f(1130) })), ok(good()), ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(saved(calls).total_amount, 1180);
  assert.equal(r.outcome, "completed");
});

test("grand total misread only by the key-figures reading: ignored, nothing flagged", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok(good()), ok(good({ grand_total: f(1000) }))]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(saved(calls).total_amount, 1180);
});

test("every reading disagrees on the grand total and nothing supports one: kept, flagged, needs review", async () => {
  const { deps, ctx, calls } = setup([ok(model({ grand_total: f(1330) })), ok(model({ grand_total: f(1340) })), ok(model({ grand_total: f(1350) })), ok(model({ grand_total: f(1360) }))]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  const e = saved(calls);
  assert.equal(e.total_amount, 1330);
  assert.equal(flagOf(e, "grand_total_unconfirmed").length, 1);
  assert.ok(e.field_status.grand_total.confidence <= 0.5);
});

test("the printed amount in words disagrees with the figures: flagged", async () => {
  const words = f("Rupees One Thousand One Hundred Fifty Only");
  const { deps, ctx, calls } = setup([ok(model({ amount_in_words: words })), ok(model({ amount_in_words: words }))], { audit: false, totalCheck: false });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  const fl = flagOf(saved(calls), "grand_total_words_mismatch");
  assert.equal(fl.length, 1);
  assert.equal(fl[0].severity, "warning");
});

test("a row missed by the first reading: the row count most readings agree on is used", async () => {
  const two = [item(), item({ description: f("Gadget") })];
  const full = model({ taxable_value: f(2000), cgst: f(180), sgst: f(180), grand_total: f(2360), line_items: two });
  const missed = { ...full, line_items: [two[0]] };
  const { deps, ctx, calls } = setup([ok(missed), ok(full), ok(full), ok(full)]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  const e = saved(calls);
  assert.equal(calls.completes[0].items.length, 2);
  assert.equal(flagOf(e, "recheck_item_count").length, 0);
  assert.equal(flagOf(e, "recheck_item_count_resolved")[0].severity, "info");
  assert.equal(flagOf(e, "arithmetic_subtotal_mismatch").length, 0);
});

test("a cell misread in one of three readings is outvoted without any flag", async () => {
  const bad = model({ line_items: [item({ quantity: f(3), taxable_value: f(1000) })] });
  const { deps, ctx, calls } = setup([ok(bad), ok(good()), ok(good()), ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(calls.completes[0].items[0].quantity, 2);
});

test("an IRN cut short in the first reading is replaced by the correctly formed one, no IRN flag is left", async () => {
  const { deps, ctx, calls } = setup([ok(good({ irn: f(IRN.slice(0, 63)) })), ok(good({ irn: f(IRN) })), ok(good({ irn: f(IRN) })), ok(good({ irn: f(IRN) }))]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  const e = saved(calls);
  assert.equal(e.irn, IRN);
  assert.equal(flagOf(e, "invalid_irn").length, 0);
});

test("an IRN that is wrong in every reading is kept as read and flagged once with the reason", async () => {
  const bad = (n) => ok(good({ irn: f(IRN.slice(0, n)) }));
  const { deps, ctx, calls } = setup([bad(62), bad(63), bad(61), bad(60)]);
  await runExtraction(deps, ctx);
  const fl = flagOf(saved(calls), "invalid_irn");
  assert.equal(fl.length, 1);
  assert.match(fl[0].message, /instead of 64/);
});

test("a layer that fails does not stop the others, and a note says which one is missing", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), down, ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.deepEqual(calls.usage.map((u) => u.outcome), ["ok", "verify_ok", "audit_provider_unavailable", "keyfigures_ok"]);
  assert.equal(flagOf(saved(calls), "audit_unavailable").length, 1);
  const k = setup([ok(good()), ok(good()), ok(good()), down]);
  await runExtraction(k.deps, k.ctx);
  assert.equal(flagOf(saved(k.calls), "keyfigures_unavailable").length, 1);
  assert.equal(saved(k.calls).total_amount, 1180);
});

test("a layer that throws is treated like a failed layer", async () => {
  const { deps, ctx, calls } = setup([ok(good())]);
  let n = 0;
  const inner = deps.gemini;
  deps.gemini = async (input) => { n += 1; if (n === 3) throw new Error("boom"); return inner(input); };
  const r = await runExtraction(deps, ctx);
  assert.notEqual(r.outcome, "failed");
  assert.equal(flagOf(saved(calls), "audit_unavailable").length, 1);
});

test("a reading that says 'not an invoice' is not voted, and is flagged", async () => {
  const { deps, ctx, calls } = setup([ok(good()), ok(good()), ok({ ...good(), document_type: "not_an_invoice" }), ok(good())]);
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  assert.equal(flagOf(saved(calls), "recheck_mismatch")[0].field, "document_type");
});

test("not enough time left: the extra layers are skipped with a note and the first reading is used", async () => {
  const { deps, ctx, calls } = setup([ok(good())], { deadlineMs: 8_000 });
  const r = await runExtraction(deps, ctx);
  assert.equal(calls.gemini.length, 1);
  assert.equal(flagOf(saved(calls), "recheck_unavailable").length, 1);
  assert.notEqual(r.outcome, "failed");
});

test("with every extra layer off, exactly one provider call is made", async () => {
  const { deps, ctx, calls } = setup([ok(good())], { verify: false, audit: false, totalCheck: false });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(calls.gemini.length, 1);
});

test("prompts: a dash is never a minus sign, the IRN rule is explicit, words are requested", () => {
  assert.match(SYSTEM_PROMPT, /lone dash/);
  assert.match(SYSTEM_PROMPT, /never a minus sign/);
  assert.match(SYSTEM_PROMPT, /exactly 64 characters/);
  assert.match(SYSTEM_PROMPT, /amount_in_words/);
  assert.match(AUDIT_SYSTEM_PROMPT, /Count the rows/);
  assert.match(KEYFIGURES_SYSTEM_PROMPT, /key figures/);
});
