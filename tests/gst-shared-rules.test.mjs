// Shared GST rules: one state table (code 25), SEZ is always IGST, round-off has a percentage cap, rates depend on the invoice date.
import test from "node:test";
import assert from "node:assert/strict";
import { gstChecks, stateCodeFromGstin, stateCodeFromPlace, STATE_NAMES } from "../lib/review/gst.ts";
import { STATE_CODES, stateCodeFromText } from "../lib/extraction/party-check.ts";
import { taxRegimeOf, UTGST_STATE_CODES } from "../lib/extraction/tax-math.ts";
import { tripleCheckTax, validateInvoice, validateInvoiceTotals } from "../lib/extraction/gst-engine.ts";
import { canonicalStateCode, isIntraStateSupply, isSezSupply, sameStateCode } from "../lib/gst/states.ts";
import { checkGstRate, ALL_GST_RATES, CURRENT_GST_RATES } from "../lib/gst/rates.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { f, missing, item, model } from "./helpers.mjs";

const OPTS = { tolerancePaise: 100 };
const norm = (m) => normalizeExtraction(m, { model: "t", now: new Date("2026-10-11") });
const codes = (r) => r.map((x) => x.code);

// ---- 1. Daman & Diu (25): one table everywhere ----------------------------------------------------------------------------
test("code 25 is known in every state table and is a UTGST UT", () => {
  assert.equal(STATE_NAMES["25"], "Daman & Diu");
  assert.equal(STATE_CODES["25"], "Daman and Diu");
  assert.equal(stateCodeFromGstin("25AAPFU0939F1ZV"), "25"); // was null
  assert.ok(UTGST_STATE_CODES.has("25"));
  for (const c of ["04", "26", "31", "35", "38"]) assert.ok(UTGST_STATE_CODES.has(c));
});

test("the two modules that map a name to a code agree (Daman and Diu -> 25, Dadra and Nagar Haveli -> 26)", () => {
  for (const [text, code] of [["Daman and Diu", "25"], ["Daman & Diu", "25"], ["Dadra and Nagar Haveli", "26"], ["Dadra & Nagar Haveli and Daman & Diu", "26"], ["Maharashtra", "27"]]) {
    assert.equal(stateCodeFromPlace(text), code, text);
    assert.equal(stateCodeFromText(text), code, text);
  }
});

test("25 and 26 are one Union Territory: a supply between them is intra-state and carries UTGST", () => {
  assert.equal(canonicalStateCode("25"), "26");
  assert.ok(sameStateCode("25", "26"));
  assert.ok(!sameStateCode("25", "27"));
  const r = taxRegimeOf({ vendor_gstin: "25AAPFU0939F1ZV", place_of_supply: "Dadra & Nagar Haveli and Daman & Diu (26)" });
  assert.equal(r.kind, "intra_state");
  assert.equal(r.expectedHeads, "CGST+UTGST");
  assert.equal(r.stateTaxHead, "UTGST");
  const flags = gstChecks({ document_type: "tax_invoice", vendor_gstin: "25AAPFU0939F1ZV", place_of_supply: "Daman and Diu (26)", taxable_amount: 1000, total_amount: 1180, cgst_amount: 90, sgst_amount: null, utgst_amount: 90, igst_amount: null, cess_amount: null }, [], OPTS);
  assert.ok(!codes(flags).includes("gst_type_mismatch") && !codes(flags).includes("supply_type_unknown"));
});

// ---- 2. SEZ ------------------------------------------------------------------------------------------------------------------
test("SEZ is detected from the printed text only", () => {
  assert.ok(isSezSupply({ place_of_supply: "Maharashtra (27) - SEZ" }));
  assert.ok(isSezSupply({ buyer_name: "Mindspace Special Economic Zone Pvt Ltd" }));
  assert.ok(!isSezSupply({ place_of_supply: "Maharashtra (27)", buyer_name: "Sezhian Traders" }));
  assert.equal(isIntraStateSupply("27", "27", true), false);
  assert.equal(isIntraStateSupply("27", "27", false), true);
  assert.equal(isIntraStateSupply("27", "96", false), null);
});

const doc = (over) => ({ document_type: "tax_invoice", vendor_gstin: "27AAPFU0939F1ZV", place_of_supply: "Maharashtra (27) SEZ", taxable_amount: 1000, total_amount: 1180, cgst_amount: null, sgst_amount: null, utgst_amount: null, igst_amount: 180, cess_amount: null, ...over });

test("IGST on a same-state SEZ supply raises no gst_type_mismatch; CGST+SGST on it does", () => {
  assert.deepEqual(codes(gstChecks(doc(), [], OPTS)), []);
  const wrong = gstChecks(doc({ igst_amount: null, cgst_amount: 90, sgst_amount: 90 }), [], OPTS);
  assert.deepEqual(codes(wrong), ["gst_type_mismatch"]);
  assert.match(wrong[0].message, /SEZ/);
  // without the SEZ text the old rule is unchanged
  assert.deepEqual(codes(gstChecks(doc({ place_of_supply: "Maharashtra (27)" }), [], OPTS)), ["gst_type_mismatch"]);
});

test("the engine's state_rule agrees: same-state SEZ with IGST is not 'unverified'", () => {
  const n = norm(model({ place_of_supply: f("Maharashtra (27) - SEZ"), cgst: missing(), sgst: missing(), igst: f(180), line_items: [item({ tax_amount: f(180), line_total: f(1180) })] }));
  const v = tripleCheckTax(n.extracted, n.items, 100);
  assert.ok(!v.disagreeing.includes("state_rule"));
  assert.ok(v.methods.some((m) => m.id === "state_rule" && /SEZ/.test(m.label)));
  const regime = taxRegimeOf(n.extracted);
  assert.equal(regime.kind, "inter_state");
  assert.equal(regime.expectedHeads, "IGST");
});

// ---- 3. Round-off has a percentage cap ----------------------------------------------------------------------------------------
test("a INR 10 invoice printed as INR 12 is a MISMATCH, not round-off", () => {
  const n = norm(model({ taxable_value: f(10), cgst: f(0), sgst: f(0), grand_total: f(12), line_items: [item({ quantity: f(1), unit_price: f(10), taxable_value: f(10), tax_amount: f(0), line_total: f(10) })] }));
  const t = validateInvoiceTotals(n.extracted, n.items, OPTS);
  assert.equal(t.passed, false);
  assert.equal(t.roundOffApplied, null);
  const r = validateInvoice({ extracted: n.extracted, items: n.items }, OPTS);
  assert.equal(r.patch.round_off_amount, undefined);
});

test("small bills keep the soft INR 1.00 tolerance; INR 2.00 round-off still works on a normal bill", () => {
  const small = (total) => { const n = norm(model({ taxable_value: f(10), cgst: f(0), sgst: f(0), grand_total: f(total), line_items: [item({ quantity: f(1), unit_price: f(10), taxable_value: f(10), tax_amount: f(0), line_total: f(10) })] })); return validateInvoiceTotals(n.extracted, n.items, OPTS); };
  assert.equal(small(10.4).passed, true);
  assert.equal(small(11).passed, true); // exactly the soft tolerance
  assert.equal(small(11.5).passed, false);
  const big = (total) => { const n = norm(model({ grand_total: f(total) })); return validateInvoiceTotals(n.extracted, n.items, OPTS); };
  assert.equal(big(1182).passed, true);
  assert.equal(big(1182.5).passed, false);
});

// ---- 4. Date-aware GST rates -----------------------------------------------------------------------------------------------
test("12% and 28% are retired from 22 Sep 2025; 40% only exists from then", () => {
  assert.equal(checkGstRate(12, "2025-09-21"), "ok");
  assert.equal(checkGstRate(12, "2025-09-22"), "retired");
  assert.equal(checkGstRate(28, "2026-10-11"), "retired");
  assert.equal(checkGstRate(18, "2026-10-11"), "ok");
  assert.equal(checkGstRate(40, "2026-10-11"), "ok");
  assert.equal(checkGstRate(40, "2025-01-10"), "not_yet");
  assert.equal(checkGstRate(17, "2026-10-11"), "unknown");
  assert.equal(checkGstRate(12, null), "ok"); // date unknown: no date rule is applied
  assert.equal(checkGstRate(0.5, null), "unknown");
  assert.equal(checkGstRate(14, "2024-01-01"), "unknown");
  assert.deepEqual([...CURRENT_GST_RATES].filter((r) => [12, 28].includes(r)), []);
  assert.ok(ALL_GST_RATES.includes(12) && ALL_GST_RATES.includes(40));
});

test("a 12% line on an Oct-2026 invoice is flagged; the same line on a 2025-06 invoice is not", () => {
  const line = { gst_rate: 12, taxable_amount: 1000, gst_amount: 120 };
  const base = { document_type: "tax_invoice", vendor_gstin: "27AAPFU0939F1ZV", place_of_supply: "Maharashtra (27)", taxable_amount: 1000, total_amount: 1120, cgst_amount: 60, sgst_amount: 60, utgst_amount: null, igst_amount: null, cess_amount: null };
  const late = gstChecks({ ...base, invoice_date: "2026-10-11" }, [line], OPTS);
  assert.deepEqual(codes(late), ["gst_rate_date_mismatch"]);
  assert.equal(late[0].severity, "warning");
  assert.equal(late[0].itemPosition, 1);
  assert.deepEqual(codes(gstChecks({ ...base, invoice_date: "2025-06-10" }, [line], OPTS)), []);
  assert.deepEqual(codes(gstChecks(base, [line], OPTS)), []);
  assert.deepEqual(codes(gstChecks({ ...base, invoice_date: "2026-10-11" }, [{ ...line, gst_rate: 17, gst_amount: 170 }], OPTS)).filter((c) => c === "unusual_gst_rate"), ["unusual_gst_rate"]);
});

test("foreign-currency invoice: INR header tax vs line amounts in the invoice currency is not reported as 'unverified'", () => {
  const n = norm(model({
    currency: f("USD"), exchange_rate: f(83), place_of_supply: f("Maharashtra (27) - SEZ"),
    taxable_value: f(83000), cgst: missing(), sgst: missing(), igst: f(14940), grand_total: f(1180),
    line_items: [item({ taxable_value: f(1000), gst_rate: f(18), tax_amount: f(180), line_total: f(1180) })],
  }));
  const v = tripleCheckTax(n.extracted, n.items, 100);
  assert.deepEqual(v.disagreeing, []);
  assert.notEqual(v.level, "unverified");
  assert.ok(!v.methods.some((m) => m.id === "printed_line_tax" || m.id === "rate_x_taxable")); // never compared across currencies
  // the same invoice in INR still compares the lines (and here they agree)
  const inr = norm(model());
  assert.ok(tripleCheckTax(inr.extracted, inr.items, 100).methods.some((m) => m.id === "rate_x_taxable"));
});
