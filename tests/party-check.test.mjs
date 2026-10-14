// GSTIN character voting, evidence checks, supplier / buyer mix-up repair, and the three-layer final audit.
import test from "node:test";
import assert from "node:assert/strict";
import { gstinChecksumChar } from "../lib/extraction/normalize.ts";
import { evidenceFor, judgeGstin, normGstin, resolveParties, stateCodeFromText, voteGstin } from "../lib/extraction/party-check.ts";
import { auditExtraction } from "../lib/extraction/final-audit.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { model, f } from "./helpers.mjs";

const mk = (first14) => first14 + gstinChecksumChar(first14);
const SUP = mk("27AAPFU0939F1Z"); // Maharashtra
const BUY = mk("29ABCDE1234F1Z"); // Karnataka
const SUP_PAN = SUP.slice(2, 12);
const party = (over = {}) => ({
  supplier_gstin: f(SUP), buyer_gstin: f(BUY), supplier_pan: f(SUP_PAN), supplier_state: f("Maharashtra, Code: 27"),
  printed_gstins: [{ value: SUP, role: "supplier", label: "GSTIN/UIN:" }, { value: BUY, role: "buyer", label: "Bill to GSTIN" }], ...over,
});
const swapChar = (g, i, c) => g.slice(0, i) + c + g.slice(i + 1);

test("test GSTINs are valid", () => {
  assert.equal(SUP.length, 15);
  assert.equal(voteGstin([SUP, SUP]).status, "unanimous");
});

test("state code: printed code, labelled code and state names", () => {
  assert.equal(stateCodeFromText("Karnataka (29)"), "29");
  assert.equal(stateCodeFromText("State Code: 27"), "27");
  assert.equal(stateCodeFromText("Tamil Nadu"), "33");
  assert.equal(stateCodeFromText("Andhra Pradesh"), "37");
  assert.equal(stateCodeFromText("Nowhere"), null);
  assert.equal(stateCodeFromText("(88)"), null);
});

test("vote: only one distinct value passes the check digit", () => {
  const v = voteGstin([swapChar(SUP, 5, "P"), SUP, swapChar(SUP, 9, "8")]);
  assert.equal(v.value, SUP);
  assert.equal(v.status, "checksum_pick");
});

test("vote: three readings, each wrong in a DIFFERENT character, are repaired character by character", () => {
  const a = swapChar(SUP, 3, "B"); // 1st reading wrong at position 4
  const b = swapChar(SUP, 8, "8"); // 2nd reading wrong at position 9
  const c = swapChar(SUP, 6, "V"); // 3rd reading wrong at position 7
  const v = voteGstin([a, b, c]);
  assert.equal(v.value, SUP);
  assert.equal(v.status, "char_vote");
  assert.equal(v.corrected, true);
});

test("vote: no majority and no unique valid combination stays a conflict (first reading is kept by the caller)", () => {
  const v = voteGstin([swapChar(SUP, 3, "B"), swapChar(SUP, 3, "C")]);
  assert.equal(v.value, null);
  assert.equal(v.status, "conflict");
});

test("vote: two DIFFERENT valid numbers with no majority is a conflict, never a guess", () => {
  assert.equal(voteGstin([SUP, BUY]).status, "conflict");
});

test("vote: a label, spaces and dashes are removed before comparing", () => {
  assert.equal(voteGstin([`GSTIN: ${SUP.slice(0, 2)} ${SUP.slice(2)}`, SUP]).status, "unanimous");
});

test("evidence: printed PAN, printed state, printed list and role", () => {
  const e = evidenceFor(SUP, "supplier", [party()]);
  assert.deepEqual([e.checksum_ok, e.state_code_ok, e.pan_printed_match, e.state_printed_match, e.in_printed_list, e.role_match], [true, true, true, true, true, true]);
  const wrongPan = evidenceFor(SUP, "supplier", [party({ supplier_pan: f("ZZZZZ9999Z") })]);
  assert.equal(wrongPan.pan_printed_match, false);
  const wrongRole = evidenceFor(SUP, "buyer", [party()]);
  assert.equal(wrongRole.role_match, false);
});

test("verdict: valid + 3 witnesses = verified; one reading only = probable; wrong PAN = conflict; bad check digit = unverified", () => {
  const vote = voteGstin([SUP, SUP, SUP, SUP]);
  assert.equal(judgeGstin("supplier_gstin", "supplier", SUP, vote, [SUP, SUP, SUP, SUP], [party()]).status, "verified");
  assert.equal(judgeGstin("supplier_gstin", "supplier", SUP, voteGstin([SUP]), [SUP], []).status, "probable");
  assert.equal(judgeGstin("supplier_gstin", "supplier", SUP, vote, [SUP, SUP, SUP, SUP], [party({ supplier_pan: f("ZZZZZ9999Z") })]).status, "conflict");
  const bad = swapChar(SUP, 14, SUP[14] === "A" ? "B" : "A");
  assert.equal(judgeGstin("supplier_gstin", "supplier", bad, voteGstin([bad, bad, bad]), [bad, bad, bad], []).status, "unverified");
  assert.equal(judgeGstin("buyer_gstin", "buyer", null, voteGstin([]), [], []).status, "absent");
});

test("resolveParties: supplier and buyer swapped in the first reading are put back when the printed roles prove it", () => {
  const first = model({ supplier_gstin: f(BUY), buyer_gstin: f(SUP) });
  const second = model({ supplier_gstin: f(BUY), buyer_gstin: f(SUP) });
  const r = resolveParties([first, second], [party(), party()], first);
  assert.equal(r.merged.supplier_gstin.value, SUP);
  assert.equal(r.merged.buyer_gstin.value, BUY);
  assert.ok(r.flags.some((x) => x.code === "gstin_roles_swapped"));
});

test("resolveParties: the same number as supplier and buyer is repaired from the printed bill-to GSTIN", () => {
  const first = model({ supplier_gstin: f(SUP), buyer_gstin: f(SUP) });
  const r = resolveParties([first], [party()], first);
  assert.equal(r.merged.buyer_gstin.value, BUY);
  assert.ok(r.flags.some((x) => x.code === "gstin_roles_swapped"));
});

test("resolveParties: no mix-up is claimed without printed role evidence", () => {
  const first = model({ supplier_gstin: f(BUY), buyer_gstin: f(SUP) });
  const r = resolveParties([first], [], first);
  assert.equal(r.merged.supplier_gstin.value, BUY);
  assert.equal(r.flags.length, 0);
});

test("resolveParties: a character-voted GSTIN no reading gave is only PROPOSED, the value that was read stays", () => {
  const a = model({ supplier_gstin: f(swapChar(SUP, 3, "B")) });
  const b = model({ supplier_gstin: f(swapChar(SUP, 8, "8")) });
  const p = party({ supplier_gstin: f(swapChar(SUP, 6, "V")) });
  const r = resolveParties([a, b], [p], a);
  assert.equal(r.merged.supplier_gstin.value, swapChar(SUP, 3, "B")); // untouched: not replaced by the assembled number
  assert.ok(!r.changed.includes("supplier_gstin"));
  const flag = r.flags.find((x) => x.code === "gstin_char_proposed");
  assert.ok(flag && flag.severity === "warning");
  assert.equal(flag.details.proposed, SUP);
  assert.ok(!r.flags.some((x) => x.code === "gstin_char_voted"));
});

// ---- final audit ----
function audit({ over = {}, readings, parties = [party()], verdicts, flags = [] } = {}) {
  const m = model({ supplier_gstin: f(SUP), buyer_gstin: f(BUY), place_of_supply: f("Karnataka (29)"), ...over });
  const { extracted, items } = normalizeExtraction(m, { model: "t", now: new Date("2026-10-13T00:00:00Z") });
  const rs = readings ?? [m, m, m];
  const v = verdicts ?? resolveParties(rs, parties, m).verdicts;
  return auditExtraction({ extracted, items, merged: m, readings: rs, parties, verdicts: v, totalStatus: "confirmed", flags, now: new Date("2026-10-13T00:00:00Z") });
}

test("audit: a clean invoice passes all three layers and every field is verified", () => {
  const { report, flags } = audit();
  assert.equal(report.passed, true);
  assert.equal(report.complete, true);
  assert.equal(report.fields.supplier_gstin.status, "verified");
  assert.equal(report.fields.buyer_gstin.status, "verified");
  assert.equal(flags.length, 0);
});

test("audit layer 1: same GSTIN for supplier and buyer, future date, state code and name that disagree", () => {
  const { report } = audit({ over: { buyer_gstin: f(SUP), invoice_date: f("2026-12-31"), place_of_supply: f("Karnataka (27)") }, parties: [] });
  const l1 = report.layers[0].failed.map((x) => x.field);
  assert.ok(l1.includes("buyer_gstin"));
  assert.ok(l1.includes("invoice_date"));
  assert.ok(l1.includes("place_of_supply"));
});

test("audit layer 2: a value that only one of three readings gave, and no rule proves, needs review", () => {
  const m = model({ invoice_number: f("INV-001") });
  const r2 = model({ invoice_number: f("INV-007") });
  const r3 = model({ invoice_number: f("INV-009") });
  const { report, flags } = audit({ over: { invoice_number: f("INV-001") }, readings: [m, r2, r3] });
  assert.equal(report.fields.invoice_number.status, "needs_review");
  assert.ok(report.fields.invoice_number.failed_layers.includes(2));
  assert.ok(flags.some((x) => x.code === "verification_failed" && /invoice number/.test(x.message)));
});

test("audit layer 2: a minority GSTIN that passes the check digit while the other reading fails it is proven, not weak", () => {
  const m = model({ supplier_gstin: f(SUP) });
  const r2 = model({ supplier_gstin: f(swapChar(SUP, 5, "P")) });
  const { report } = audit({ readings: [m, r2], parties: [] });
  assert.ok(!report.layers[1].failed.some((x) => x.field === "supplier_gstin"));
});

test("audit layer 3: the parties reading read a different PAN or a different supplier name", () => {
  const { report, flags } = audit({ parties: [party({ supplier_pan: f("ZZZZZ9999Z"), supplier_name: f("Totally Different Co") })] });
  assert.equal(report.fields.supplier_gstin.status, "needs_review");
  assert.ok(report.fields.supplier_name.failed_layers.includes(3));
  assert.ok(flags.some((x) => x.code === "gstin_conflict" && x.field === "supplier_gstin"));
});

test("audit layer 3: a supplier name that is only shorter or longer is not a conflict", () => {
  const { report } = audit({ parties: [party({ supplier_name: f("Acme Traders Pvt Ltd") })] });
  assert.equal(report.fields.supplier_name.status, "verified");
});

test("audit: an absent buyer GSTIN (B2C) is not a failure", () => {
  const { report } = audit({ over: { buyer_gstin: { status: "missing", value: null, confidence: 0.9 } }, parties: [party({ buyer_gstin: { status: "missing", value: null, confidence: 0.9 }, printed_gstins: [{ value: SUP, role: "supplier", label: "GSTIN" }] })] });
  assert.equal(report.fields.buyer_gstin.status, "not_present");
  assert.equal(report.passed, true);
});
