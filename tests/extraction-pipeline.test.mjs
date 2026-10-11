import test from "node:test";
import assert from "node:assert/strict";
import { runExtraction, duplicateFlag } from "../lib/extraction/pipeline.ts";
import { model, minimalPdf, png, sha, f, missing } from "./helpers.mjs";

const pdf = minimalPdf();
const geminiConfig = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000 };

function setup({ responses, bytes = pdf, mime = "application/pdf", candidates = [], dupThrows = false, completeResult = "ok", sizeSha, config = {}, clock } = {}) {
  const calls = { gemini: 0, usage: [], completes: [], sleeps: [] };
  let t = Date.parse("2026-10-11T00:00:00Z");
  const deps = {
    geminiConfig: { ...geminiConfig, ...config },
    maxPdfPages: 10,
    now: clock ?? (() => t),
    sleep: async (ms) => { calls.sleeps.push(ms); t += ms; },
    random: () => 0,
    log: () => {},
    files: { download: async () => bytes },
    gemini: async () => {
      const r = responses[Math.min(calls.gemini, responses.length - 1)];
      calls.gemini += 1;
      t += 1000;
      return typeof r === "function" ? r() : r;
    },
    store: {
      recordUsage: async (u) => { calls.usage.push(u); },
      findDuplicateCandidates: async () => { if (dupThrows) throw new Error("db"); return candidates; },
      complete: async (a) => { calls.completes.push(a); return completeResult; },
    },
  };
  const ctx = { jobId: "job1", invoiceId: "inv1", firmId: "firm1", userId: "user1", storagePath: "firm1/inv1.pdf", mime, sha256: sizeSha ?? (bytes ? sha(bytes) : "0".repeat(64)) };
  return { deps, ctx, calls };
}

const okRes = (m = model(), usage = { inputTokens: 1000, outputTokens: 400 }) => ({ ok: true, text: JSON.stringify(m), usage });
const err = (code, retryable, extra = {}) => ({ ok: false, code, retryable, ...extra });

test("clean invoice: completed, saved once, usage and cost recorded", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes()] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(r.attempts, 1);
  assert.equal(calls.completes.length, 1);
  const saved = calls.completes[0];
  assert.equal(saved.outcome, "completed");
  assert.equal(saved.extracted.total_amount, 1180);
  assert.equal(saved.items.length, 1);
  assert.equal(calls.usage.length, 1);
  assert.equal(calls.usage[0].inputTokens, 1000);
  assert.equal(calls.usage[0].costUsd, 0.0013); // 1000*0.3/1e6 + 400*2.5/1e6
  assert.equal(calls.usage[0].outcome, "ok");
});

test("arithmetic mismatch => needs_review, amounts saved exactly as extracted", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes(model({ grand_total: f(1300) }))] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  const saved = calls.completes[0];
  assert.equal(saved.extracted.total_amount, 1300);
  assert.ok(saved.extracted.review_flags.some((x) => x.code === "arithmetic_total_mismatch"));
});

test("retries transient provider errors with backoff, then succeeds", async () => {
  const { deps, ctx, calls } = setup({ responses: [err("provider_unavailable", true), err("provider_rate_limited", true, { retryAfterMs: 3000 }), okRes()] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(r.attempts, 3);
  assert.deepEqual(calls.sleeps, [1000, 3000]);
  assert.equal(calls.usage.length, 3);
});

test("gives up after max attempts with the last error code", async () => {
  const { deps, ctx, calls } = setup({ responses: [err("provider_unavailable", true)] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "failed");
  assert.equal(r.errorCode, "provider_unavailable");
  assert.equal(r.attempts, 3);
  assert.equal(calls.completes[0].outcome, "failed");
  assert.equal(calls.completes[0].errorCode, "provider_unavailable");
  assert.equal(calls.completes[0].extracted, null);
});

test("non-retryable provider errors stop immediately", async () => {
  const { deps, ctx, calls } = setup({ responses: [err("provider_auth", false)] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.errorCode, "provider_auth");
  assert.equal(calls.gemini, 1);
});

test("invalid model output is retried, never saved, and fails with a clear code", async () => {
  const bad = { ok: true, text: JSON.stringify({ ...model(), extra: 1 }), usage: { inputTokens: 10, outputTokens: 10 } };
  const { deps, ctx, calls } = setup({ responses: [bad] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.errorCode, "invalid_model_output");
  assert.equal(calls.gemini, 3);
  assert.equal(calls.completes.length, 1);
  assert.equal(calls.completes[0].extracted, null);
  assert.equal(calls.usage.length, 3); // tokens were still billed
  assert.equal(calls.usage[0].outcome, "invalid_model_output");
});

test("non-JSON then valid JSON recovers; fenced JSON is accepted", async () => {
  const { deps, ctx } = setup({ responses: [{ ok: true, text: "Sorry, here you go", usage: { inputTokens: 1, outputTokens: 1 } }, { ok: true, text: "```json\n" + JSON.stringify(model()) + "\n```", usage: { inputTokens: 1, outputTokens: 1 } }] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "completed");
  assert.equal(r.attempts, 2);
});

test("not_an_invoice fails without saving fields", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes(model({ document_type: "not_an_invoice" }))] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.errorCode, "not_an_invoice");
  assert.equal(calls.completes[0].extracted, null);
});

test("file problems fail before any provider call (no cost)", async () => {
  let s = setup({ responses: [okRes()], bytes: null });
  assert.equal((await runExtraction(s.deps, s.ctx)).errorCode, "file_missing");
  assert.equal(s.calls.gemini, 0);

  s = setup({ responses: [okRes()], sizeSha: "0".repeat(64) });
  assert.equal((await runExtraction(s.deps, s.ctx)).errorCode, "file_integrity");

  const broken = pdf.subarray(0, pdf.length - 12);
  s = setup({ responses: [okRes()], bytes: broken });
  assert.equal((await runExtraction(s.deps, s.ctx)).errorCode, "malformed_pdf");
  assert.equal(s.calls.gemini, 0);

  s = setup({ responses: [okRes()], bytes: png(100, 100), mime: "image/png" });
  assert.equal((await runExtraction(s.deps, s.ctx)).errorCode, "image_too_small");
  assert.equal(s.calls.gemini, 0);
});

test("deadline stops retries instead of overrunning the function time limit", async () => {
  const { deps, ctx, calls } = setup({ responses: [err("provider_timeout", true)], config: { deadlineMs: 12_000, timeoutMs: 10_000 } });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "failed");
  assert.equal(r.errorCode, "provider_timeout");
  assert.ok(calls.gemini < 3);
});

test("each provider call gets a timeout no longer than the remaining time", async () => {
  const seen = [];
  const { deps, ctx } = setup({ responses: [okRes()], config: { deadlineMs: 20_000, timeoutMs: 40_000 } });
  deps.gemini = async (input) => { seen.push(input.timeoutMs); return okRes(); };
  await runExtraction(deps, ctx);
  assert.ok(seen[0] <= 19_000);
});

test("possible duplicate is flagged (same number + supplier), not blocked", async () => {
  const { deps, ctx, calls } = setup({
    responses: [okRes()],
    candidates: [{ invoiceId: "other", vendorGstin: "27AAPFU0939F1ZV", vendorName: "Acme Traders", matchedBy: "number" }],
  });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  const flag = calls.completes[0].extracted.review_flags.find((x) => x.code === "possible_duplicate");
  assert.deepEqual(flag.details.invoiceIds, ["other"]);
});

test("same invoice number from a different supplier is not a duplicate", async () => {
  const { deps, ctx } = setup({
    responses: [okRes()],
    candidates: [{ invoiceId: "other", vendorGstin: "29AABCT1332L1ZP", vendorName: "Someone Else", matchedBy: "number" }],
  });
  assert.equal((await runExtraction(deps, ctx)).outcome, "completed");
});

test("duplicate check failure is flagged, not hidden", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes()], dupThrows: true });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "needs_review");
  assert.ok(calls.completes[0].extracted.review_flags.some((x) => x.code === "duplicate_check_unavailable"));
});

test("duplicateFlag supplier matching rules", () => {
  const e = { vendor_gstin: null, vendor_name: "Acme Traders" };
  assert.ok(duplicateFlag(e, [{ invoiceId: "a", vendorGstin: null, vendorName: "ACME  traders", matchedBy: "number" }]));
  assert.equal(duplicateFlag(e, [{ invoiceId: "a", vendorGstin: null, vendorName: "Other", matchedBy: "number" }]), null);
  assert.ok(duplicateFlag({ vendor_gstin: "X", vendor_name: null }, [{ invoiceId: "a", vendorGstin: "X", vendorName: null, matchedBy: "fingerprint" }]));
  assert.equal(duplicateFlag(e, []), null);
});

test("a job that is no longer processing is not overwritten", async () => {
  const { deps, ctx } = setup({ responses: [okRes()], completeResult: "not_processing" });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "failed");
  assert.equal(r.errorCode, "stale_timeout");
});

test("unexpected exceptions become internal_error and the job is still closed", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes()] });
  deps.gemini = async () => { throw new Error("boom with details"); };
  const r = await runExtraction(deps, ctx);
  assert.equal(r.errorCode, "internal_error");
  assert.equal(calls.completes.at(-1).outcome, "failed");
});

test("a failing usage insert does not break extraction", async () => {
  const { deps, ctx } = setup({ responses: [okRes()] });
  deps.store.recordUsage = async () => { throw new Error("db"); };
  assert.equal((await runExtraction(deps, ctx)).outcome, "completed");
});

test("missing optional values are saved as null with their state", async () => {
  const { deps, ctx, calls } = setup({ responses: [okRes(model({ buyer_gstin: missing() }))] });
  await runExtraction(deps, ctx);
  const e = calls.completes[0].extracted;
  assert.equal(e.buyer_gstin, null);
  assert.equal(e.field_status.buyer_gstin.state, "missing");
});
