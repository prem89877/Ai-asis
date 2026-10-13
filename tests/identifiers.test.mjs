// IRN / acknowledgement number / e-way bill number: cleaning, repair, and how a bad IRN is judged across readings.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanIdentifier, describeIdentifierProblem, isValidIrn } from "../lib/extraction/identifiers.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { reconcile, reconcileMany, recheckFlags } from "../lib/extraction/verify.ts";
import { f, model } from "./helpers.mjs";

const HEX = "0123456789abcdef";
const IRN = (HEX.repeat(4)).slice(0, 64);
const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });

test("IRN: label, spaces, line breaks, dashes and upper case are cleaned; nothing else is touched", () => {
  const wrapped = `IRN: ${IRN.slice(0, 32).toUpperCase()}\n ${IRN.slice(32).toUpperCase()}`;
  const c = cleanIdentifier("irn", wrapped);
  assert.deepEqual(c, { value: IRN, valid: true });
  assert.equal(cleanIdentifier("irn", `IRN No. - ${IRN.slice(0, 20)} - ${IRN.slice(20)}`).value, IRN);
  assert.equal(cleanIdentifier("irn", `e-Invoice IRN : ${IRN}`).valid, true);
});

test("IRN: O/Q for 0 and I/l for 1 are repaired only when the result is exactly 64 hex characters, and it is reported", () => {
  const bad = IRN.replace("0123", "O1Z3").replace("Z", "2"); // O for 0
  const c = cleanIdentifier("irn", bad);
  assert.equal(c.valid, true);
  assert.equal(c.value, IRN);
  assert.ok(c.repaired && c.repaired.from.includes("o") === false);
  const withL = cleanIdentifier("irn", IRN.replace("1", "l"));
  assert.equal(withL.valid, true);
  assert.equal(withL.value, IRN);
  // other letters are never guessed
  const g = cleanIdentifier("irn", IRN.replace("a", "z"));
  assert.equal(g.valid, false);
});

test("IRN with a missing or extra character is not valid and the message says what is wrong", () => {
  const short = IRN.slice(0, 62);
  assert.equal(cleanIdentifier("irn", short).valid, false);
  assert.match(describeIdentifierProblem("irn", short), /only 62 characters instead of 64/);
  assert.match(describeIdentifierProblem("irn", IRN + "ab"), /66 characters instead of 64/);
  assert.match(describeIdentifierProblem("irn", IRN.slice(0, 60) + "zzzz"), /cannot be in an IRN/);
  assert.equal(describeIdentifierProblem("irn", IRN), null);
  assert.equal(isValidIrn(IRN), true);
});

test("acknowledgement number and e-way bill number lose their label, spaces and dashes", () => {
  assert.equal(cleanIdentifier("ack_no", "Ack No: 1120 1001 2345 678").value, "112010012345678");
  assert.equal(cleanIdentifier("ack_no", "Acknowledgement Number - 112010012345678").valid, true);
  assert.equal(cleanIdentifier("eway_bill_no", "E-way Bill No: 1234-5678-9012").value, "123456789012");
  assert.equal(cleanIdentifier("eway_bill_no", "12345678901").valid, false);
});

test("normalization stores a clean IRN and raises no flag for it", () => {
  const n = norm(model({ irn: f(`IRN: ${IRN.slice(0, 40)} ${IRN.slice(40)}`) }));
  assert.equal(n.extracted.irn, IRN);
  const r = validateInvoice(n, { tolerancePaise: 100 });
  assert.equal(r.flags.filter((x) => x.code === "invalid_irn").length, 0);
});

test("a repaired look-alike IRN is stored repaired and reported as information", () => {
  const n = norm(model({ irn: f(IRN.replace("0", "O")) }));
  assert.equal(n.extracted.irn, IRN);
  const fl = n.extracted.review_flags.filter((x) => x.code === "irn_lookalike_repaired");
  assert.equal(fl.length, 1);
  assert.equal(fl[0].severity, "info");
});

test("a bad IRN is kept as read and flagged once, with the real reason", () => {
  const n = norm(model({ irn: f(IRN.slice(0, 63)) }));
  assert.equal(n.extracted.irn, IRN.slice(0, 63));
  const r = validateInvoice(n, { tolerancePaise: 100 });
  const fl = r.flags.filter((x) => x.code === "invalid_irn");
  assert.equal(fl.length, 1);
  assert.match(fl[0].message, /only 63 characters instead of 64/);
});

test("two readings of an IRN: the reading with 64 hex characters wins", () => {
  const first = model({ irn: f(IRN.slice(0, 63)) });
  const second = model({ irn: f(IRN) });
  const rec = reconcile(first, second, OPTS);
  assert.equal(rec.merged.irn.value, IRN);
  const fl = recheckFlags(rec).filter((x) => x.field === "irn");
  assert.equal(fl.length, 1);
  assert.equal(fl[0].code, "recheck_corrected");
});

test("three readings of an IRN: two matching readings win even when the third is cut short", () => {
  const rec = reconcileMany([model({ irn: f(IRN.slice(0, 63)) }), model({ irn: f(IRN) }), model({ irn: f(IRN.toUpperCase()) })], OPTS);
  assert.equal(rec.merged.irn.value, IRN);
  assert.equal(recheckFlags(rec).filter((x) => x.severity === "warning").length, 0);
});
