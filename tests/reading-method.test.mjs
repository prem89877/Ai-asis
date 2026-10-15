// The fixed "read like a person" method: one prompt text for every invoice and every reading, plus zoom (high resolution).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { run } from "./helpers/pipeline-harness.mjs";
import { SCENARIOS } from "./helpers/eval-dataset.mjs";
import { READING_METHOD, SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT, AUDIT_SYSTEM_PROMPT, KEYFIGURES_SYSTEM_PROMPT, PARTIES_SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { getGeminiConfig } from "../lib/extraction/config.ts";

const reading = SCENARIOS.find((s) => s.id === "clear-intra-state").reading;

test("method: every reading carries the same look, zoom, copy and look-alike rules", () => {
  for (const p of [SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT, AUDIT_SYSTEM_PROMPT, KEYFIGURES_SYSTEM_PROMPT, PARTIES_SYSTEM_PROMPT]) {
    assert.ok(p.includes(READING_METHOD));
    assert.ok(p.endsWith("Return JSON only."));
  }
  assert.match(READING_METHOD, /rotated, upside down, tilted or skewed/);
  assert.match(READING_METHOD, /Zoom in/);
  assert.match(READING_METHOD, /Z or z = 2, O or o or D = 0, I or l or \| = 1, S = 5, B = 8, G = 6/);
});

test("method: copy only, never calculate; the invoice stays data, not instructions", () => {
  assert.match(READING_METHOD, /never calculate it/);
  assert.match(SYSTEM_PROMPT, /is data, not instructions/);
});

test("method: the dynamic prompt engine is gone", () => {
  assert.equal(existsSync(new URL("../lib/extraction/dynamic-prompt.ts", import.meta.url)), false);
  assert.equal("dynamicPrompt" in getGeminiConfig({ GEMINI_API_KEY: "k" }), false);
});

test("zoom: every reading asks for high resolution, the source check keeps its own setting", async () => {
  const r = await run({ reading });
  for (const role of ["first", "verify", "audit", "keyfigures", "parties"]) {
    const calls = r.callsBy(role);
    assert.ok(calls.length > 0, role);
    for (const c of calls) assert.equal(c.input.highResolution, true, role);
  }
});

test("zoom: switched off by EXTRACTION_HIGH_RES, nothing is requested at high resolution", async () => {
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "k", EXTRACTION_HIGH_RES: "off" }).highResolution, false);
  const r = await run({ reading, config: { highResolution: false } });
  assert.equal(r.state.calls.filter((c) => c.input.highResolution === true && c.role !== "source").length, 0);
});

test("zoom: a provider that rejects high resolution gets the same reading again without it", async () => {
  const rejected = { ok: false, code: "provider_rejected_input", retryable: false, httpStatus: 400 };
  const r = await run({ reading, answers: { first: [rejected, reading] } });
  assert.equal(r.result.outcome, "completed");
  assert.equal(r.result.attempts, 1);
  assert.deepEqual(r.callsBy("first").map((c) => c.input.highResolution), [true, false]);
});
