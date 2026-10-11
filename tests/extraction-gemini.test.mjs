import test from "node:test";
import assert from "node:assert/strict";
import { callGemini, estimateCostUsd, readUsage } from "../lib/extraction/gemini.ts";

const base = { apiKey: "SECRET-KEY", model: "gemini-test", mime: "application/pdf", data: new Uint8Array([1, 2, 3]), timeoutMs: 200, maxOutputTokens: 1000 };
const res = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const ok = (text, extra = {}) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50 }, ...extra });

test("success returns text and usage (thinking tokens billed as output)", async () => {
  const r = await callGemini({ ...base, fetchImpl: async () => res(200, ok("{}")) });
  assert.equal(r.ok, true);
  assert.equal(r.text, "{}");
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 250 });
});

test("API key is sent in a header, never in the URL or body", async () => {
  let seen;
  await callGemini({ ...base, fetchImpl: async (url, init) => ((seen = { url: String(url), init }), res(200, ok("{}"))) });
  assert.ok(!seen.url.includes("SECRET-KEY"));
  assert.ok(!seen.init.body.includes("SECRET-KEY"));
  assert.equal(seen.init.headers["x-goog-api-key"], "SECRET-KEY");
  assert.ok(seen.url.includes("gemini-test:generateContent"));
  const body = JSON.parse(seen.init.body);
  assert.equal(body.generationConfig.temperature, 0);
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, "application/pdf");
});

test("HTTP errors map to codes and retryability", async () => {
  const cases = [
    [429, "provider_rate_limited", true], [503, "provider_unavailable", true], [504, "provider_timeout", true],
    [401, "provider_auth", false], [403, "provider_auth", false], [404, "provider_model_unavailable", false], [400, "provider_rejected_input", false],
  ];
  for (const [status, code, retryable] of cases) {
    const r = await callGemini({ ...base, fetchImpl: async () => res(status, { error: { message: "x" } }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, code, String(status));
    assert.equal(r.retryable, retryable, String(status));
  }
});

test("Retry-After is honoured and capped", async () => {
  const r = await callGemini({ ...base, fetchImpl: async () => res(429, {}, { "retry-after": "7" }) });
  assert.equal(r.retryAfterMs, 7000);
  const r2 = await callGemini({ ...base, fetchImpl: async () => res(429, {}, { "retry-after": "9999" }) });
  assert.equal(r2.retryAfterMs, 60000);
});

test("timeout aborts the request", async () => {
  const slow = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await callGemini({ ...base, timeoutMs: 30, fetchImpl: slow });
  assert.equal(r.ok, false);
  assert.equal(r.code, "provider_timeout");
  assert.equal(r.retryable, true);
});

test("network failure is a retryable provider error", async () => {
  const r = await callGemini({ ...base, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(r.code, "provider_unavailable");
  assert.equal(r.retryable, true);
});

test("blocked, truncated and empty responses", async () => {
  assert.equal((await callGemini({ ...base, fetchImpl: async () => res(200, { promptFeedback: { blockReason: "SAFETY" } }) })).code, "provider_blocked");
  const trunc = await callGemini({ ...base, fetchImpl: async () => res(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
  assert.equal(trunc.code, "output_truncated");
  assert.equal(trunc.retryable, false);
  assert.deepEqual(trunc.usage, { inputTokens: 10, outputTokens: 5 }); // billed even though unusable
  assert.equal((await callGemini({ ...base, fetchImpl: async () => res(200, { candidates: [] }) })).code, "empty_response");
  assert.equal((await callGemini({ ...base, fetchImpl: async () => res(200, "not json") })).code, "empty_response");
  const safety = await callGemini({ ...base, fetchImpl: async () => res(200, { candidates: [{ finishReason: "SAFETY" }] }) });
  assert.equal(safety.code, "provider_blocked");
});

test("thought parts are ignored", async () => {
  const body = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking...", thought: true }, { text: "{\"a\":1}" }] } }] };
  const r = await callGemini({ ...base, fetchImpl: async () => res(200, body) });
  assert.equal(r.text, "{\"a\":1}");
});

test("cost estimate and usage parsing", () => {
  assert.equal(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 0.3, 2.5), 2.8);
  assert.equal(estimateCostUsd({ inputTokens: 2000, outputTokens: 500 }, 0.3, 2.5), 0.00185);
  assert.equal(readUsage(undefined), undefined);
  assert.equal(readUsage({}), undefined);
});
