// Second layer of the tax math (tax-math.ts): CGST / SGST / UTGST equality, UTGST regime, line tax vs rate, Cess / TCS / TDS
// plausibility, diagnosis of a wrong total, UTGST labels, and the tax-head guidance in the fixed prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { validateInvoice } from "../lib/extraction/gst-engine.ts";
import { checkTaxHeads, diagnoseTotalMismatch, taxRegimeOf, UTGST_STATE_CODES } from "../lib/extraction/tax-math.ts";
import { normalizeAppliedTaxType, normalizeExtraction } from "../lib/extraction/normalize.ts";
import { SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { f, missing, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const run = (m) => validateInvoice(norm(m), OPTS);
const codes = (r) => r.flags.map((x) => x.code);

test("clean CGST + SGST invoice: the second layer adds no flag", () => {
  const r = run(model());
  assert.deepEqual(r.flags, []);
  assert.equal(r.summary.tax_regime.expectedHeads, "CGST+SGST");
});

test("UTGST: a Chandigarh supplier selling inside Chandigarh is expected to charge CGST + UTGST, stored in the sgst field", () => {
  const r = run(model({ supplier_gstin: f("04AAPFU0939F1ZV"), place_of_supply: f("Chandigarh (04)") }));
  assert.equal(r.summary.tax_regime.expectedHeads, "CGST+UTGST");
  assert.equal(r.summary.tax_regime.stateTaxHead, "UTGST");
  assert.ok(!codes(r).includes("cgst_sgst_unequal"));
});

test("Delhi, Puducherry and J&K charge SGST, not UTGST", () => {
  for (const code of ["07", "34", "01"]) assert.ok(!UTGST_STATE_CODES.has(code));
  for (const code of ["04", "26", "31", "35", "38"]) assert.ok(UTGST_STATE_CODES.has(code));
  assert.equal(taxRegimeOf({ vendor_gstin: "07AAPFU0939F1ZV", place_of_supply: "Delhi (07)" }).expectedHeads, "CGST+SGST");
});

test("regime: different states = IGST expected; foreign / unknown place of supply = not determined", () => {
  assert.equal(taxRegimeOf({ vendor_gstin: "27AAPFU0939F1ZV", place_of_supply: "Karnataka (29)" }).expectedHeads, "IGST");
  assert.equal(taxRegimeOf({ vendor_gstin: "27AAPFU0939F1ZV", place_of_supply: "Foreign (96)" }).kind, "not_determined");
  assert.equal(taxRegimeOf({ vendor_gstin: null, place_of_supply: null }).kind, "not_determined");
});

test("CGST and SGST / UTGST with different amounts: warning on sgst", () => {
  const r = run(model({ sgst: f(60), grand_total: f(1150) }));
  const flag = r.flags.find((x) => x.code === "cgst_sgst_unequal");
  assert.ok(flag);
  assert.equal(flag.severity, "warning");
  assert.equal(flag.details.difference, 30);
});

test("only CGST read, SGST missing, no IGST: one-sided warning", () => {
  const r = run(model({ sgst: missing(), grand_total: f(1090) }));
  assert.ok(codes(r).includes("cgst_sgst_one_sided"));
});

test("IGST invoice (no CGST / SGST): no equality or one-sided flag", () => {
  const r = run(model({ place_of_supply: f("Karnataka (29)"), cgst: missing(), sgst: missing(), igst: f(180) }));
  assert.ok(!codes(r).includes("cgst_sgst_unequal") && !codes(r).includes("cgst_sgst_one_sided"));
});

test("line tax that does not match taxable x rate is flagged; half of it (one head printed) is accepted", () => {
  assert.ok(codes(run(model({ line_items: [item({ tax_amount: f(108) })] }))).includes("line_tax_rate_mismatch"));
  assert.ok(!codes(run(model({ line_items: [item({ tax_amount: f(90) })] }))).includes("line_tax_rate_mismatch"));
});

test("Cess far above the taxable value is flagged as implausible; a normal cess is not", () => {
  const big = run(model({ cess: f(9000), grand_total: f(10180) }));
  assert.ok(codes(big).includes("cess_implausible"));
  const ok = run(model({ cess: f(50), grand_total: f(1230) }));
  assert.ok(!codes(ok).includes("cess_implausible"));
});

test("TCS and TDS above 20% of the taxable value are flagged; normal ones are not", () => {
  assert.ok(codes(run(model({ tds_amount: f(500), grand_total: f(1180) }))).includes("tds_implausible"));
  assert.ok(codes(run(model({ tcs_amount: f(500), grand_total: f(1680) }))).includes("tcs_implausible"));
  const ok = run(model({ tcs_amount: f(1), tds_amount: f(1), grand_total: f(1181) }));
  assert.ok(!codes(ok).includes("tcs_implausible") && !codes(ok).includes("tds_implausible"));
});

test("wrong total: the diagnosis names the head that was left out", () => {
  const noSgst = run(model({ grand_total: f(1090) }));
  const flag = noSgst.flags.find((x) => x.code === "arithmetic_total_mismatch");
  assert.ok(flag);
  assert.ok(flag.details.likelyCauses.some((c) => c.code === "total_without_sgst" || c.code === "total_without_cgst"));
  const noCess = run(model({ cess: f(50), grand_total: f(1180) }));
  assert.ok(noCess.flags.find((x) => x.code === "arithmetic_total_mismatch").details.likelyCauses.some((c) => c.code === "total_without_cess"));
});

test("diagnoseTotalMismatch: TDS, TCS, cess, duplicate head, nothing found", () => {
  const parts = { actual: 0, base: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 5000, tcs: 1000, tds: 2000, discount: null, charges: null, expectedTotal: 124000, lineImpliedTax: null };
  assert.equal(diagnoseTotalMismatch({ ...parts, actual: 122000 })[0].code, "total_is_after_tds");
  assert.equal(diagnoseTotalMismatch({ ...parts, actual: 123000 })[0].code, "total_without_tcs");
  assert.equal(diagnoseTotalMismatch({ ...parts, actual: 119000 })[0].code, "total_without_cess");
  assert.equal(diagnoseTotalMismatch({ ...parts, actual: 133000 })[0].code, "sgst_counted_twice");
  assert.deepEqual(diagnoseTotalMismatch({ ...parts, actual: 150123 }), []);
});

test("checkTaxHeads never changes the invoice", () => {
  const e = norm(model({ sgst: f(60), grand_total: f(1150) }));
  const before = JSON.stringify(e);
  checkTaxHeads(e, [], 100);
  assert.equal(JSON.stringify(e), before);
});

test("applied_tax_type labels with UTGST", () => {
  // UTGST is its own head: CGST with UTGST only is a Union Territory line. A label naming SGST too stays CGST_SGST (older readings).
  for (const t of ["CGST+UTGST", "CGST & UTGST", "UTGST/CGST", "CGST_UTGST"]) assert.equal(normalizeAppliedTaxType(t), "CGST_UTGST", t);
  for (const t of ["CGST+SGST/UTGST", "SGST/UTGST + CGST", "CGST_SGST"]) assert.equal(normalizeAppliedTaxType(t), "CGST_SGST", t);
  assert.equal(normalizeAppliedTaxType("IGST"), "IGST");
  assert.equal(normalizeAppliedTaxType("UTGST"), null);
  assert.equal(normalizeAppliedTaxType("IGST + CGST"), null);
});

// ---- Fixed prompt: tax-head guidance ------------------------------------------------------------------------------------------

test("fixed prompt: tax-head guidance is present, copy-only", () => {
  assert.match(SYSTEM_PROMPT, /cgst, sgst, utgst_amount and igst/);
  assert.match(SYSTEM_PROMPT, /UTGST \(Union Territory GST\) is its OWN figure: put it in utgst_amount, never into sgst and never into cgst/);
  assert.match(SYSTEM_PROMPT, /TCS and TDS are not tax heads/);
  assert.match(SYSTEM_PROMPT, /cess is its own figure/);
});
