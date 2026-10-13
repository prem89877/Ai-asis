// Grand total: amount in words -> number, and the witness count that decides which total is trusted.
import test from "node:test";
import assert from "node:assert/strict";
import { parseAmountInWords, resolveGrandTotal } from "../lib/extraction/total-check.ts";
import { f, model, missing } from "./helpers.mjs";

const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const w = (s) => parseAmountInWords(s);

test("amount in words: Indian and international number words", () => {
  assert.deepEqual(w("Rupees One Thousand One Hundred Eighty Only"), { value: 1180, hasMinor: false });
  assert.equal(w("INR Five Hundred Only").value, 500);
  assert.equal(w("Rupees Forty Five Only").value, 45);
  assert.equal(w("Rupees Fourty Only").value, 40);
  assert.equal(w("One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees Only").value, 123456);
  assert.equal(w("Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only").value, 123456789);
  assert.equal(w("Rupees Eleven Hundred Only").value, 1100);
  assert.equal(w("Rupees Twenty-One Thousand Only").value, 21000);
  assert.equal(w("Two Thousand Five Hundred Rupees Only").value, 2500);
});

test("amount in words: paise", () => {
  assert.deepEqual(w("Rupees One Thousand And Fifty Paise Only"), { value: 1000.5, hasMinor: true });
  assert.deepEqual(w("One Thousand One Hundred Eighty Rupees and Forty Paise Only"), { value: 1180.4, hasMinor: true });
  assert.deepEqual(w("Rupees Two Hundred and Five Paise Only"), { value: 200.05, hasMinor: true });
});

test("amount in words: anything not understood is skipped, never guessed", () => {
  assert.equal(w("Rupees One Thousand Foo Only"), null);
  assert.equal(w("Rs. 1,180/-"), null);
  assert.equal(w(""), null);
  assert.equal(w(null), null);
  assert.equal(w("Rupees Only"), null);
});

const reading = (source, total, words) => ({ source, total: total === undefined ? undefined : f(total), words: words ? f(words) : undefined });
const WORDS_1180 = "Rupees One Thousand One Hundred Eighty Only";

test("every witness agrees: confirmed, no flag", () => {
  const v = resolveGrandTotal([reading("first", 1180, WORDS_1180), reading("second", 1180), reading("audit", 1180, WORDS_1180), reading("keyfigures", 1180, WORDS_1180)], model(), OPTS);
  assert.equal(v.status, "confirmed");
  assert.equal(v.field.value, 1180);
  assert.equal(v.flags.length, 0);
  assert.equal(v.wordsMatch, true);
  assert.ok(v.candidates[0].witnesses.includes("words") && v.candidates[0].witnesses.includes("arithmetic"));
});

test("the chosen value is replaced only by a value with at least 3 witnesses", () => {
  // chosen so far: 1130 (e.g. the first reading). Three other readings, the words and the arithmetic say 1180.
  const wrong = model({ grand_total: f(1130) });
  const v = resolveGrandTotal([reading("first", 1130), reading("second", 1180), reading("audit", 1180), reading("keyfigures", 1180, WORDS_1180)], wrong, OPTS);
  assert.equal(v.status, "corrected");
  assert.equal(v.field.value, 1180);
  const fl = v.flags.find((x) => x.code === "grand_total_corrected");
  assert.equal(fl.severity, "info");
  assert.equal(fl.details.before, 1130);
  // only two witnesses for the other value: the chosen one stays
  const v2 = resolveGrandTotal([reading("first", 1130), reading("second", 1190)], model({ grand_total: f(1130) }), OPTS);
  assert.equal(v2.field.value, 1130);
});

test("no witness agrees with another: warning, confidence lowered", () => {
  const v = resolveGrandTotal([reading("first", 1330), reading("second", 1340), reading("audit", 1350)], model({ grand_total: f(1330) }), OPTS);
  assert.equal(v.status, "unconfirmed");
  const fl = v.flags.find((x) => x.code === "grand_total_unconfirmed");
  assert.equal(fl.severity, "warning");
  assert.ok(v.field.confidence <= 0.5);
});

test("a total that disagrees with the printed words is flagged (warning when little else supports it)", () => {
  const v = resolveGrandTotal([reading("first", 1180, "Rupees One Thousand One Hundred Fifty Only"), reading("second", 1180)], model(), OPTS);
  const fl = v.flags.find((x) => x.code === "grand_total_words_mismatch");
  assert.ok(fl);
  assert.equal(v.wordsMatch, false);
  assert.deepEqual(fl.details, { figures: 1180, words: 1150 });
});

test("words without paise tolerate the paise of the figure; words with paise must match exactly", () => {
  const m = model({ grand_total: f(1180.4) });
  const a = resolveGrandTotal([reading("first", 1180.4, WORDS_1180), reading("second", 1180.4)], m, OPTS);
  assert.equal(a.wordsMatch, true);
  const b = resolveGrandTotal([reading("first", 1180.4, "Rupees One Thousand One Hundred Eighty and Fifty Paise Only"), reading("second", 1180.4)], m, OPTS);
  assert.equal(b.wordsMatch, false);
});

test("no reading has a total: nothing to decide, nothing invented", () => {
  const v = resolveGrandTotal([{ source: "first", total: missing(), words: undefined }], model({ grand_total: missing() }), OPTS);
  assert.equal(v.status, "no_value");
  assert.equal(v.field, null);
});

test("a single reading raises no 'unconfirmed' warning (the extra layers are switched off)", () => {
  const v = resolveGrandTotal([reading("first", 1180)], model(), OPTS);
  assert.equal(v.flags.length, 0);
});
