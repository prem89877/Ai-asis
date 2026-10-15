// GST validation engine: ONE entry point, validateInvoice(), built from small independent algorithms.
// Nothing here changes an extracted value. It only returns flags, a summary, and (for round-off) a derived value
// that the caller may save with source "computed".
//
// Every important figure is checked by more than one independent method ("triple check"):
//   line level   : validateLineItem()       qty x price - discount, x exchange rate        (arithmetic.ts)
//   tax level    : validateTaxAllocation()  per-line IGST / CGST / SGST / UTGST sums vs the invoice (Rule 2, mixed tax)
//   total level  : validateInvoiceTotals()  two-tier total: grand total (taxable + taxes + TCS) OR net payable (- TDS), +/- round-off (Rule 3)
//   cross check  : tripleCheckTax()         printed header tax  vs  printed line tax  vs  rate x taxable  vs  state rule
// An invoice is shown as "verified" only when every method that could run agrees. Disagreement is never hidden.
import { checkLineItems, hasRate, isForeign, rateToleranceFor } from "./arithmetic.ts";
import { describeIdentifierProblem, isValidAckNo, isValidEwayBill, isValidIrn } from "./identifiers.ts";
import { toPaise } from "./normalize.ts";
import { hasStateTax, isCessInclusiveLineTotal, known as knownAmt, reconcileHeads, removeCessFromLineTaxes, splitLineTaxes, stateTaxPaise, taxHeadsPaise, totalTaxPaise } from "./tax-components.ts";
import { checkTaxHeads, diagnoseTotalMismatch, type TaxRegime } from "./tax-math.ts";
import { componentFlag, reconcileTaxComponents } from "./tax-reconcile.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export { validateLineItem } from "./arithmetic.ts";

// A difference up to this (INR 2.00) is absorbed into round_off_amount and the total check PASSES.
export const ROUND_OFF_MAX_PAISE = 200;
const MAX_INFERENCE_LINES = 16; // 2^16 line splits are tried when IGST and CGST/SGST are mixed and lines carry no tax type

export interface EngineOptions {
  tolerancePaise: number; // soft tolerance, 100 = INR 1.00
}
export interface InvoiceData {
  extracted: StoredExtracted;
  items: StoredItem[];
}

const p = (v: number | null | undefined): number => (v === null || v === undefined ? 0 : toPaise(v));
const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const nonZero = (v: number | null | undefined): boolean => has(v) && v !== 0;

// ---- Rule 2: per-line tax (IGST / CGST / SGST), mixed-tax invoices ----------------------------------------------------

export type TaxType = "IGST" | "CGST_SGST" | "CGST_UTGST" | "NONE";

// Tax on one line in paise: the printed tax amount, else taxable x rate. null when neither can be known.
export function lineTaxPaise(it: StoredItem): number | null {
  if (has(it.gst_amount)) return toPaise(it.gst_amount);
  if (has(it.gst_rate) && has(it.taxable_amount)) return toPaise((it.taxable_amount * it.gst_rate) / 100);
  return null;
}

export interface TaxAllocation {
  method: "labelled" | "inferred" | "not_needed" | "unverified";
  mixed: boolean;
  ambiguous?: boolean;
  assignment?: TaxType[]; // per line, when inferred
  lineIgst: number; // INR sums of the lines
  lineCgst: number;
  lineSgst: number;
  lineUtgst: number;
  flags: ReviewFlag[];
}

export function validateTaxAllocation(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): TaxAllocation {
  const flags: ReviewFlag[] = [];
  const heads = taxHeadsPaise(e);
  const igstH = heads.igst, cgstH = heads.cgst, stateH = stateTaxPaise(heads); // stateH = SGST + UTGST, each counted once
  const mixed = nonZero(e.igst_amount) && (nonZero(e.cgst_amount) || hasStateTax(e));
  const tol = tolerancePaise + Math.min(items.length, 200); // each line's tax is rounded to the paisa
  const out = (method: TaxAllocation["method"], extra: Partial<TaxAllocation> = {}): TaxAllocation => ({ method, mixed, lineIgst: 0, lineCgst: 0, lineSgst: 0, lineUtgst: 0, flags, ...extra });
  let taxes = items.map(lineTaxPaise);
  // A line tax that already contains the cess (GST + cess) is not CGST + SGST: take the cess out (only on exact evidence, see tax-components.ts).
  const noCess = removeCessFromLineTaxes(e, items, taxes, tol);
  if (noCess) taxes = noCess.taxes;
  const known = items.length > 0 && taxes.every((t) => t !== null);
  const labelled = items.length > 0 && items.every((it) => it.applied_tax_type === "IGST" || it.applied_tax_type === "CGST_SGST" || it.applied_tax_type === "CGST_UTGST" || it.applied_tax_type === "NONE");

  if (labelled && known) {
    // Every line says which tax family it carries, so each head is rebuilt from the lines on its own and compared with the
    // invoice head. CGST and SGST are NOT forced to be equal: UTGST lines add to the state-level side next to SGST lines.
    const split = splitLineTaxes(items, taxes);
    const utKnown = knownAmt(e.utgst_amount);
    // Legacy invoice (no utgst_amount stored): the state-level side is compared as one figure, SGST + UTGST.
    const bad: string[] = [];
    if (Math.abs(split.igst - igstH) > tol) bad.push("IGST");
    if (Math.abs(split.cgst - cgstH) > tol) bad.push("CGST");
    if (utKnown) {
      if (Math.abs(split.sgst - heads.sgst) > tol) bad.push("SGST");
      if (Math.abs(split.utgst - heads.utgst) > tol) bad.push("UTGST");
    } else if (Math.abs(split.sgst + split.utgst - stateH) > tol) bad.push(split.utgst > 0 && split.sgst === 0 ? "UTGST" : "SGST");
    const discrepancies = reconcileHeads(heads, utKnown ? split : { ...split, sgst: split.sgst + split.utgst, utgst: 0 }, tol);
    if (bad.length > 0) {
      // Each failed head is explained on its own: field, expected value (from the lines), observed value (on the invoice), reason.
      const explained = reconcileTaxComponents(e, items, tolerancePaise).heads;
      const base: ReviewFlag = {
        code: "tax_allocation_mismatch", severity: "warning",
        message: `The ${bad.join(", ")} of the individual lines does not add up to the invoice ${bad.join(", ")}. Check the original.`,
        details: {
          lineIgst: split.igst / 100, lineCgst: split.cgst / 100, lineSgst: split.sgst / 100, lineUtgst: split.utgst / 100,
          invoiceIgst: igstH / 100, invoiceCgst: cgstH / 100, invoiceSgst: heads.sgst / 100, invoiceUtgst: heads.utgst / 100,
          mismatchedHeads: bad, discrepancies,
        },
      };
      if (explained.length > 0) {
        const detailed = componentFlag("tax_allocation_mismatch", explained);
        flags.push({ ...base, field: detailed.field, message: detailed.message, details: { ...base.details, ...detailed.details } });
      } else {
        flags.push(base);
      }
    } else if (mixed) {
      flags.push({ code: "mixed_tax_invoice", severity: "info", message: "IGST and CGST/SGST/UTGST are both charged. This is allowed when different lines carry different taxes, and every line adds up." });
    }
    return out("labelled", { lineIgst: split.igst / 100, lineCgst: split.cgst / 100, lineSgst: split.sgst / 100, lineUtgst: split.utgst / 100 });
  }

  if (!mixed) return out("not_needed");

  // IGST and CGST/SGST both on the invoice but the lines do not say which tax they carry: find the split that works.
  if (!known || items.length > MAX_INFERENCE_LINES) {
    flags.push({ code: "mixed_tax_unverified", severity: "info", message: "IGST and CGST/SGST are both charged, but the line items do not show which tax applies to which line, so the split could not be verified." });
    return out("unverified");
  }
  const n = items.length;
  const total = taxes.reduce<number>((a, t) => a + (t as number), 0);
  const solutions: number[] = [];
  for (let mask = 0; mask < 1 << n && solutions.length < 3; mask++) {
    let sumIgst = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sumIgst += taxes[i] as number;
    const half = (total - sumIgst) / 2;
    if (Math.abs(sumIgst - igstH) <= tol && Math.abs(half - cgstH) <= tol && Math.abs(half - stateH) <= tol) solutions.push(mask);
  }
  if (solutions.length === 0) {
    flags.push({
      code: "mixed_tax_unreconciled", severity: "warning",
      message: "IGST and CGST/SGST are both charged and no split of the line items reproduces them. Check the original.",
      details: { invoiceIgst: igstH / 100, invoiceCgst: cgstH / 100, invoiceSgst: heads.sgst / 100, invoiceUtgst: heads.utgst / 100 },
    });
    return out("unverified");
  }
  const assignment: TaxType[] = items.map((_, i) => (solutions[0] & (1 << i) ? "IGST" : "CGST_SGST"));
  flags.push({
    code: "mixed_tax_inferred", severity: "info",
    message: solutions.length > 1
      ? "IGST and CGST/SGST are both charged. More than one split of the lines reproduces them, so the line-wise tax type is not certain."
      : "IGST and CGST/SGST are both charged. One split of the lines reproduces both exactly, so the invoice is treated as a valid mixed-tax invoice.",
    details: { assignment, ambiguous: solutions.length > 1 },
  });
  return out("inferred", { assignment, ambiguous: solutions.length > 1 });
}

// ---- Multi-slab summary (0 / 5 / 12 / 18 / 28 ... on one invoice) ---------------------------------------------------

export interface Slab {
  rate: number;
  taxType: TaxType | "UNKNOWN";
  taxable: number;
  tax: number; // INR, from the printed line tax, else taxable x rate
  lines: number;
}

export function slabSummary(items: StoredItem[], assignment?: TaxType[]): Slab[] {
  const map = new Map<string, { rate: number; taxType: Slab["taxType"]; taxable: number; tax: number; lines: number }>();
  items.forEach((it, i) => {
    if (!has(it.gst_rate) || !has(it.taxable_amount)) return;
    const type: Slab["taxType"] = it.applied_tax_type ?? assignment?.[i] ?? "UNKNOWN";
    const key = `${type}|${it.gst_rate}`;
    const s = map.get(key) ?? { rate: it.gst_rate, taxType: type, taxable: 0, tax: 0, lines: 0 };
    s.taxable += toPaise(it.taxable_amount);
    s.tax += lineTaxPaise(it) ?? 0;
    s.lines += 1;
    map.set(key, s);
  });
  return Array.from(map.values())
    .map((s) => ({ ...s, taxable: s.taxable / 100, tax: s.tax / 100 }))
    .sort((a, b) => a.rate - b.rate || a.taxType.localeCompare(b.taxType));
}

// ---- Rule 3: multi-tier total reconciliation (grand total, net payable, TCS / TDS, pre-tax charges, round-off) ---------
//
// An enterprise invoice can print its bottom line in two ways, and both are normal:
//   Tier 1  GRAND TOTAL  = Taxable + CGST + SGST + IGST + Cess + TCS            (TCS is charged on top, so it is inside the total)
//   Tier 2  NET PAYABLE  = Grand total - TDS (Sec 194Q withholding)              (TDS is deducted from the payment, not charged)
// The printed "grand_total" can be either figure, so it is accepted when it reproduces Tier 1 OR Tier 2, within INR 2.00 of
// round-off. When the document prints net_payable_amount as its own figure, that figure is cross-checked against the total.
// A difference up to INR 2.00 is round-off: it is absorbed and the check PASSES.

export type TotalTier = "grand_total" | "net_payable";

export interface TotalsResult {
  flags: ReviewFlag[];
  passed: boolean | null; // null = not enough values to check
  status: "VALIDATED" | "MISMATCH" | "NOT_CHECKED"; // same verdict as `passed`, spelled out
  matchedTier: TotalTier | null; // which tier the printed grand total reproduced (null = none, or not checked)
  expectedGrandTotal: number | null; // INR, Tier 1: taxable + taxes + TCS
  expectedNetPayable: number | null; // INR, Tier 2: Tier 1 - TDS (null when there is no TDS)
  calculatedTotal: number | null; // INR, the calculated figure the printed total was compared with
  roundOffApplied: number | null; // INR, signed, set only when a difference was absorbed
  roundOffAbsorbed: number; // INR, absolute size of the absorbed difference (0 when none)
  // What the printed discount did to the printed total: "deducted_after_tax" (total = taxable + taxes + TCS - discount),
  // "not_in_total" (a discount is printed but the total reproduces without it: it is already inside the taxable value, or only informational),
  // "none" (no discount printed), null when the total was not checked or did not match.
  discountTreatment: "deducted_after_tax" | "not_in_total" | "none" | null;
}

const NOT_CHECKED = (flags: ReviewFlag[]): TotalsResult => ({
  flags, passed: null, status: "NOT_CHECKED", matchedTier: null, expectedGrandTotal: null, expectedNetPayable: null,
  calculatedTotal: null, roundOffApplied: null, roundOffAbsorbed: 0, discountTreatment: null,
});

export function validateInvoiceTotals(e: StoredExtracted, items: StoredItem[], opts: EngineOptions): TotalsResult {
  const flags: ReviewFlag[] = [];
  const tol = opts.tolerancePaise;
  const fs = e.field_status ?? {};
  const foreignRate = isForeign(e.currency, e.exchange_rate) && hasRate(e.exchange_rate) ? e.exchange_rate : null;
  const rateTol = rateToleranceFor(fs); // wider when the exchange rate was fetched instead of printed
  const itemsKnown = items.length > 0 && items.every((it) => it.taxable_amount !== null);
  const itemsSum = itemsKnown ? items.reduce((a, it) => a + toPaise(it.taxable_amount as number), 0) : null;
  const charges = has(e.pre_tax_charges) ? toPaise(e.pre_tax_charges) : null;
  const header = e.taxable_amount;

  // Item taxable values -> invoice taxable value. Freight / insurance / packaging may be lines of their own, or only
  // added to the invoice taxable value, so both readings are accepted.
  if (header !== null && itemsSum !== null) {
    const candidates = [toPaise(header)];
    if (e.discount_amount !== null) candidates.push(toPaise(header) + toPaise(e.discount_amount));
    if (charges !== null) candidates.push(toPaise(header) - charges, toPaise(header) + charges);
    if (!candidates.some((c) => Math.abs(itemsSum - c) <= tol + items.length)) {
      flags.push({
        code: "arithmetic_subtotal_mismatch", severity: "error", field: "taxable_value",
        message: "The item taxable values do not add up to the invoice taxable value.",
        details: { itemsSum: itemsSum / 100, extracted: header / 100 },
      });
    }
  }

  const base0 = header !== null ? toPaise(header) : itemsSum;
  const total = e.total_amount;
  if (total === null || base0 === null) return NOT_CHECKED(flags);

  // Every head counted once: CGST + SGST + UTGST + IGST + cess (see tax-components.ts).
  const tax = totalTaxPaise(taxHeadsPaise(e));
  // TCS can only ever add to the invoice and TDS can only ever reduce the payment. Invoices print them as "(-) 1,000.00",
  // "Less: TDS 1,000.00" or plain, so the direction comes from what the figure IS, not from the sign it was printed with.
  const tcs = Math.abs(p(e.tcs_amount)), tds = Math.abs(p(e.tds_amount));
  const printedRo = has(e.round_off_amount) ? toPaise(e.round_off_amount) : 0;
  const disc = e.discount_amount !== null ? toPaise(e.discount_amount) : null;
  const actual = toPaise(total);

  const tier1 = (base: number) => base + tax + tcs; // grand total
  const tier2 = (base: number) => base + tax + tcs - tds; // net payable
  const bases = [base0];
  if (charges !== null) bases.push(base0 + charges); // charges only added to the taxable base, not inside it

  // Every figure the printed total may legitimately be. Tier 1 is listed before Tier 2, so on a tie Tier 1 wins.
  interface Variant { value: number; rel: number; tier: TotalTier; disc?: boolean } // disc = the printed discount was deducted after tax in this reading
  const variants: Variant[] = [];
  for (const b of bases) {
    variants.push({ value: tier1(b), rel: 0, tier: "grand_total" });
    if (disc !== null) variants.push({ value: tier1(b) - disc, rel: 0, tier: "grand_total", disc: true });
    if (tds !== 0) {
      variants.push({ value: tier2(b), rel: 0, tier: "net_payable" });
      if (disc !== null) variants.push({ value: tier2(b) - disc, rel: 0, tier: "net_payable", disc: true });
    }
  }
  if (foreignRate !== null) { // total printed in the foreign currency while taxable and taxes are in INR
    variants.push({ value: Math.round(tier1(base0) / foreignRate), rel: rateTol, tier: "grand_total" });
    if (tds !== 0) variants.push({ value: Math.round(tier2(base0) / foreignRate), rel: rateTol, tier: "net_payable" });
  }
  // Credit / debit notes and returns: the printed total can carry the opposite sign.
  const signed = variants.flatMap((v) => (actual < 0 !== v.value < 0 && actual !== 0 ? [v, { ...v, value: -v.value }] : [v]));

  // Distance of the printed total from a variant, after accounting for a printed round-off (or the rate allowance).
  const distance = (v: Variant) => {
    const diff = actual - v.value;
    return v.rel === 0 ? Math.min(Math.abs(diff - printedRo), Math.abs(diff)) : Math.max(0, Math.abs(diff) - Math.round(Math.abs(v.value) * v.rel));
  };
  let b = signed[0];
  let bestDist = distance(b);
  for (const v of signed.slice(1)) {
    const d = distance(v);
    if (d < bestDist) { b = v; bestDist = d; }
  }
  const diff = actual - b.value;
  const expectedGrand = tier1(base0) / 100;
  const expectedNet = tds !== 0 ? tier2(base0) / 100 : null;
  const absorbMax = Math.max(tol, ROUND_OFF_MAX_PAISE);

  let calcPaise = b.value;
  const verdict = (matched: boolean, roundOffApplied: number | null = null): TotalsResult => ({
    flags, passed: matched, status: matched ? "VALIDATED" : "MISMATCH", matchedTier: matched ? b.tier : null,
    expectedGrandTotal: expectedGrand, expectedNetPayable: expectedNet,
    calculatedTotal: matched ? calcPaise / 100 : expectedGrand,
    roundOffApplied: roundOffApplied === null ? null : roundOffApplied / 100,
    roundOffAbsorbed: roundOffApplied === null ? 0 : Math.abs(roundOffApplied) / 100,
    discountTreatment: !matched ? null : b.disc ? "deducted_after_tax" : disc !== null && disc !== 0 ? "not_in_total" : "none",
  });

  let matched = false;
  let absorbed: number | null = null;
  if (b.rel > 0) {
    matched = Math.abs(diff) <= tol + Math.round(Math.abs(b.value) * b.rel);
  } else if (printedRo !== 0 && Math.abs(diff - printedRo) <= tol) {
    matched = true; // the printed round-off explains the difference
    calcPaise = b.value + printedRo;
  } else if (Math.abs(diff) <= absorbMax) {
    matched = true;
    if (diff !== 0) {
      // Difference of up to INR 2.00: absorbed into round_off_amount, total check PASSES. Normal rounding (within the soft
      // tolerance) is silent; a larger absorbed difference leaves an info note so nobody is surprised by it.
      absorbed = diff;
      if (Math.abs(diff) > tol) flags.push({
        code: "round_off_absorbed", severity: "info", field: "round_off_amount",
        message: `A difference of INR ${(diff / 100).toFixed(2)} between the calculated and the printed total was recorded as round-off.`,
        details: { calculated: b.value / 100, extracted: actual / 100, roundOff: diff / 100, tier: b.tier, ...(printedRo !== 0 ? { printedRoundOff: printedRo / 100 } : {}) },
      });
    }
  }

  if (!matched) {
    // utgst_amount is optional (most invoices have none), so its absence is never reported here.
    const absent = (["cgst", "sgst", "igst", "cess"] as const).filter((k) => fs[k]?.state === "missing");
    // Second layer (tax-math.ts): which single tax head, if left out or counted twice, would explain the printed total?
    const lineImplied = items.length > 0 && items.every((it) => has(it.gst_rate) && has(it.taxable_amount))
      ? items.reduce((a, it) => a + toPaise(((it.taxable_amount as number) * (it.gst_rate as number)) / 100), 0)
      : null;
    const causes = diagnoseTotalMismatch({
      actual, base: base0, cgst: Math.abs(p(e.cgst_amount)), sgst: Math.abs(p(e.sgst_amount)), utgst: Math.abs(p(e.utgst_amount)), igst: Math.abs(p(e.igst_amount)), cess: Math.abs(p(e.cess_amount)),
      tcs, tds, discount: disc, charges, expectedTotal: tier1(base0), lineImpliedTax: lineImplied,
    });
    const headTax = Math.abs(p(e.cgst_amount)) + Math.abs(p(e.sgst_amount)) + Math.abs(p(e.utgst_amount)) + Math.abs(p(e.igst_amount));
    const taxDisagrees = lineImplied !== null && foreignRate === null && Math.abs(Math.abs(lineImplied) - headTax) > tol + items.length;
    const netPrinted = has(e.net_payable_amount) ? toPaise(e.net_payable_amount) : null;
    const money = (v: number) => `INR ${(v / 100).toFixed(2)}`;
    const reason = causes.length > 0 ? causes[0].message : "The printed total does not equal taxable value + CGST + SGST + UTGST + IGST + cess (+ TCS, - printed discount) and no single tax head explains the gap.";
    flags.push({
      code: "arithmetic_total_mismatch", severity: "error", field: "grand_total",
      message: `Taxable value plus taxes (plus TCS, less TDS where printed) does not equal the grand total or the net payable. Expected ${money(tier1(base0))}, found ${money(actual)} (difference ${money(actual - tier1(base0))}).${causes.length > 0 ? ` Most likely: ${causes[0].message}` : ""}`,
      details: {
        field: "grand_total", observed: actual / 100, reason, // expected / extracted / difference below, per component in `components`
        difference: (actual - tier1(base0)) / 100,
        components: {
          taxable: base0 / 100, cgst: p(e.cgst_amount) / 100, sgst: p(e.sgst_amount) / 100, utgst: p(e.utgst_amount) / 100, igst: p(e.igst_amount) / 100, cess: p(e.cess_amount) / 100,
          tcs: tcs / 100, tds: tds / 100, discount: disc === null ? null : disc / 100, preTaxCharges: charges === null ? null : charges / 100,
        },
        ...(causes.length > 0 ? { likelyCauses: causes } : {}),
        ...(taxDisagrees ? { taxFromLineRates: Math.abs(lineImplied as number) / 100, taxPrintedOnInvoice: headTax / 100 } : {}),
        expected: expectedGrand, extracted: actual / 100, taxFieldsNotFound: absent,
        ...(expectedNet !== null ? { expectedNetPayable: expectedNet } : {}),
        ...(header === null ? { taxableFromItems: true } : {}),
        ...(tcs !== 0 ? { tcs: tcs / 100 } : {}), ...(tds !== 0 ? { tds: tds / 100 } : {}), ...(charges !== null ? { preTaxCharges: charges / 100 } : {}),
        // Helps the reviewer: a printed net payable that matches the calculation points to a misread grand total.
        ...(netPrinted !== null && expectedNet !== null ? { printedNetPayable: netPrinted / 100, printedNetPayableMatchesCalculation: Math.abs(netPrinted - tier2(base0)) <= absorbMax } : {}),
      },
    });
    return verdict(false);
  }

  flags.push(...checkNetPayable(e, actual, b.tier, tds, printedRo, absorbMax, b.disc === true ? null : disc));
  flags.push(...checkAdjustmentConfusion(e, tcs, tds, disc, absorbMax));
  return verdict(true, absorbed);
}

// The printed net_payable_amount against the printed total. Which of the two it must equal depends on the tier the
// printed total reproduced: a Tier 1 total is before TDS (net = total - TDS); a Tier 2 total already is the net figure.
// `postTotalDiscount` = the printed commercial discount (paise) when the printed total is BEFORE it (the total was reproduced without it),
// so a net payable that is lower by exactly that discount is explained. It is null when the total already is net of the discount.
function checkNetPayable(e: StoredExtracted, actual: number, tier: TotalTier, tds: number, printedRo: number, absorbMax: number, postTotalDiscount: number | null = null): ReviewFlag[] {
  if (!has(e.net_payable_amount)) return [];
  const net = toPaise(e.net_payable_amount);
  const expected = tier === "grand_total" ? actual - tds : actual;
  const diff = net - expected;
  // Round-off is sometimes applied to the net figure instead of the grand total, so the same INR 2.00 window applies.
  if (Math.abs(diff) <= absorbMax || (printedRo !== 0 && Math.abs(diff - printedRo) <= absorbMax)) return [];
  // A commercial discount printed under the subtotal lowers the amount payable. It is NOT a TDS deduction, so it must neither be
  // reported as a missing TDS nor as a net-payable mismatch.
  if (postTotalDiscount !== null && postTotalDiscount > 0) {
    const withDiscount = net - (expected - postTotalDiscount);
    if (Math.abs(withDiscount) <= absorbMax || (printedRo !== 0 && Math.abs(withDiscount - printedRo) <= absorbMax)) return [];
  }
  if (tier === "grand_total" && !nonZero(e.tds_amount)) {
    // Net payable is lower than the grand total and no TDS was read: most likely the TDS line was not captured.
    return [{
      code: "net_payable_tds_not_found", severity: "info", field: "net_payable_amount",
      message: `The net payable differs from the grand total by INR ${((actual - net) / 100).toFixed(2)} but no TDS amount was read. Check the TDS line on the original.`,
      details: { grandTotal: actual / 100, netPayable: net / 100, impliedDeduction: (actual - net) / 100 },
    }];
  }
  return [{
    code: "net_payable_mismatch", severity: "warning", field: "net_payable_amount",
    message: tier === "grand_total"
      ? "The net payable does not equal the grand total less TDS. Check the original."
      : "The net payable does not equal the printed total, which already matches the figure after TDS. Check the original.",
    details: { expected: expected / 100, extracted: net / 100, grandTotalTier: tier, ...(tds !== 0 ? { tds: tds / 100 } : {}) },
  }];
}

// TCS and TDS are withholding / collection items; a commercial discount is a price reduction. When a TCS or TDS figure is exactly
// the printed discount, one of them was probably copied into the wrong field. Both are kept as read and a person is asked to look.
function checkAdjustmentConfusion(e: StoredExtracted, tcs: number, tds: number, disc: number | null, absorbMax: number): ReviewFlag[] {
  if (disc === null || disc === 0) return [];
  const out: ReviewFlag[] = [];
  const d = Math.abs(disc);
  for (const [amount, field, label, role] of [[tds, "tds_amount", "TDS", "withheld from the payment"], [tcs, "tcs_amount", "TCS", "collected on top of the invoice"]] as const) {
    if (amount !== 0 && Math.abs(amount - d) <= Math.min(absorbMax, 100)) {
      out.push({
        code: `${label.toLowerCase()}_matches_discount`, severity: "warning", field,
        message: `The ${label} (INR ${(amount / 100).toFixed(2)}) is exactly the printed discount. ${label} is ${role}; a commercial discount only reduces the invoice value. One of them may have been copied into the wrong field. Check the original.`,
        details: { field, observed: amount / 100, expected: 0, reason: `${label} equals the discount figure`, discount: d / 100 },
      });
    }
  }
  return out;
}

// ---- e-invoice / e-way bill metadata: format notes only, never part of a calculation ----------------------------------

export function validateEInvoiceMetadata(e: StoredExtracted): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const note = (code: string, field: string, message: string, value: string) => flags.push({ code, severity: "info", field, message, details: { length: value.length } });
  if (e.irn && !isValidIrn(e.irn)) note("invalid_irn", "irn", describeIdentifierProblem("irn", e.irn) as string, e.irn);
  if (e.ack_no && !isValidAckNo(e.ack_no)) note("invalid_ack_no", "ack_no", describeIdentifierProblem("ack_no", e.ack_no) as string, e.ack_no);
  if (e.eway_bill_no && !isValidEwayBill(e.eway_bill_no)) note("invalid_eway_bill_no", "eway_bill_no", describeIdentifierProblem("eway_bill_no", e.eway_bill_no) as string, e.eway_bill_no);
  return flags;
}

// ---- Negative lines (returns, rebates, trade-volume discounts) ---------------------------------------------------------------
// A negative line is normal on some invoices, so it is NOT flagged line by line. It is judged once per invoice:
//   - credit / debit notes: negative figures are expected, nothing to say;
//   - signs on the line agree and the item taxable values (negative lines included) add up to the invoice taxable value:
//     believable, silent, recorded in the summary only;
//   - a line whose signs disagree (e.g. negative taxable value but positive tax), or an invoice that adds up only when the
//     negative lines are made positive: the minus sign was probably misread (a "-" in an empty cell is the usual cause) => warning;
//   - otherwise (nothing to tie to): ONE information note listing the item numbers.

export interface NegativeLines {
  positions: number[]; // 1-based item numbers
  status: "confirmed" | "unconfirmed" | "suspect" | "not_applicable";
  flags: ReviewFlag[];
}

const isNeg = (v: number | null | undefined): boolean => has(v) && v < 0;

function itemList(positions: number[]): string {
  return (positions.length === 1 ? "Item " : "Items ") + positions.join(", ");
}

// Does the sum of item taxable values tie to the invoice taxable value (same candidates as the subtotal check)?
function itemsTie(e: StoredExtracted, itemsSum: number, items: StoredItem[], tol: number): boolean {
  const header = e.taxable_amount;
  if (header === null) return false;
  const charges = has(e.pre_tax_charges) ? toPaise(e.pre_tax_charges) : null;
  const candidates = [toPaise(header)];
  if (e.discount_amount !== null) candidates.push(toPaise(header) + toPaise(e.discount_amount));
  if (charges !== null) candidates.push(toPaise(header) - charges, toPaise(header) + charges);
  return candidates.some((c) => Math.abs(itemsSum - c) <= tol + items.length);
}

export function validateNegativeLines(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): NegativeLines {
  const memo = e.document_type === "credit_note" || e.document_type === "debit_note";
  const positions = items.map((it, i) => (isNeg(it.taxable_amount) || isNeg(it.quantity) || isNeg(it.line_total) ? i + 1 : 0)).filter((n) => n > 0);
  if (memo || positions.length === 0) return { positions, status: "not_applicable", flags: [] };

  // Signs on one line must agree: taxable value, tax and line total are all negative together.
  const mixedSigns = positions.filter((pos) => {
    const it = items[pos - 1];
    const parts = [it.taxable_amount, it.gst_amount, it.line_total].filter((v): v is number => has(v) && v !== 0);
    return parts.some((v) => v < 0) && parts.some((v) => v > 0);
  });

  const known = items.length > 0 && items.every((it) => it.taxable_amount !== null);
  let direct: boolean | null = null;
  let flipped: boolean | null = null;
  if (known && e.taxable_amount !== null) {
    const sum = items.reduce((a, it) => a + toPaise(it.taxable_amount as number), 0);
    const flipSum = items.reduce((a, it, i) => a + (positions.includes(i + 1) ? Math.abs(toPaise(it.taxable_amount as number)) : toPaise(it.taxable_amount as number)), 0);
    direct = itemsTie(e, sum, items, tolerancePaise);
    flipped = itemsTie(e, flipSum, items, tolerancePaise);
  }

  const flags: ReviewFlag[] = [];
  if (mixedSigns.length > 0) {
    flags.push({
      code: "negative_line_suspect", severity: "warning",
      message: `${itemList(mixedSigns)}: the minus sign is on some amounts of the line but not on others. A "-" in an empty cell may have been read as a minus sign. Compare with the original.`,
      details: { positions: mixedSigns },
    });
    return { positions, status: "suspect", flags };
  }
  if (direct === false && flipped === true) {
    flags.push({
      code: "negative_line_suspect", severity: "warning",
      message: `${itemList(positions)} read as negative, but the item total matches the invoice only if they are positive. A "-" may have been read as a minus sign. Compare with the original.`,
      details: { positions },
    });
    return { positions, status: "suspect", flags };
  }
  if (direct === true) return { positions, status: "confirmed", flags };
  flags.push({
    code: "negative_line_items", severity: "info",
    message: `${itemList(positions)} ${positions.length === 1 ? "is a negative line" : "are negative lines"} (return, rebate or discount). ${known && e.taxable_amount !== null ? "The item total does not match the invoice taxable value, see the other checks." : "They could not be tied to the invoice totals."}`,
    details: { positions },
  });
  return { positions, status: "unconfirmed", flags };
}

// ---- Cross check of the invoice's tax by independent methods -----------------------------------------------------------

export interface Verification {
  level: "verified" | "partial" | "unverified" | "not_checked";
  methods: { id: string; label: string; value: number }[]; // INR total tax by each method
  disagreeing: string[];
}

function stateOf(text: string | null | undefined, kind: "gstin" | "place"): string | null {
  if (!text) return null;
  const m = kind === "gstin" ? /^(\d{2})/.exec(text) : /\((\d{2})\)/.exec(text) ?? /^\s*(\d{2})\b/.exec(text);
  return m ? m[1] : null;
}

export function tripleCheckTax(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): Verification {
  const tol = tolerancePaise + Math.min(items.length, 200);
  const methods: Verification["methods"] = [];
  const headerKnown = [e.cgst_amount, e.sgst_amount, e.utgst_amount, e.igst_amount].some(has);
  if (!headerKnown) return { level: "not_checked", methods, disagreeing: [] };
  const header = p(e.cgst_amount) + p(e.sgst_amount) + p(e.utgst_amount) + p(e.igst_amount); // total GST, each head once
  methods.push({ id: "printed_invoice_tax", label: "CGST + SGST + UTGST + IGST printed on the invoice", value: header / 100 });
  if (items.length > 0 && items.every((it) => has(it.gst_amount))) {
    methods.push({ id: "printed_line_tax", label: "Sum of the tax printed on each line", value: items.reduce((a, it) => a + p(it.gst_amount), 0) / 100 });
  }
  if (items.length > 0 && items.every((it) => has(it.gst_rate) && has(it.taxable_amount))) {
    methods.push({ id: "rate_x_taxable", label: "Taxable value x GST rate, line by line", value: items.reduce((a, it) => a + toPaise(((it.taxable_amount as number) * (it.gst_rate as number)) / 100), 0) / 100 });
  }
  const disagreeing: string[] = [];
  const cessP = p(e.cess_amount);
  for (const m of methods.slice(1)) {
    let v = toPaise(m.value);
    // A line-derived total that equals GST + cess is the cess-inclusive pattern (see tax-components.ts): compare it without the cess.
    if (isCessInclusiveLineTotal(e, items, v, tol)) { v -= cessP; m.value = v / 100; m.label += ` (cess INR ${(cessP / 100).toFixed(2)} excluded)`; }
    if (Math.abs(v - header) > tol) disagreeing.push(m.id);
  }

  // Fourth, rule-based method: supplier state vs place of supply decides which tax head is expected.
  const sup = stateOf(e.vendor_gstin, "gstin"), pos = stateOf(e.place_of_supply, "place");
  const mixed = nonZero(e.igst_amount) && (nonZero(e.cgst_amount) || hasStateTax(e));
  if (sup && pos && pos !== "96" && pos !== "97" && !mixed && header !== 0) {
    const intra = sup === pos;
    const ok = intra ? !nonZero(e.igst_amount) : !(nonZero(e.cgst_amount) || hasStateTax(e));
    methods.push({ id: "state_rule", label: intra ? "Same state: CGST + SGST / UTGST expected" : "Different states: IGST expected", value: header / 100 });
    if (!ok) disagreeing.push("state_rule");
  }
  const level: Verification["level"] = disagreeing.length > 0 ? "unverified" : methods.length >= 3 ? "verified" : "partial";
  return { level, methods, disagreeing };
}

// ---- Unified entry point ------------------------------------------------------------------------------------------------

export interface ValidationSummary {
  version: 1;
  currency: string; // "INR" when nothing else was printed
  exchange_rate: number; // 1.0 when nothing else was printed
  extracted_total: number | null;
  calculated_total: number | null;
  total_check: "passed" | "failed" | "not_checked";
  total_tier: TotalTier | null; // which reading of the printed total passed: "grand_total" (Tier 1) or "net_payable" (Tier 2)
  expected_grand_total: number | null; // Taxable + taxes + TCS
  expected_net_payable: number | null; // expected_grand_total - TDS (null when there is no TDS)
  round_off_applied: number | null;
  tax_allocation: { method: TaxAllocation["method"]; mixed: boolean; ambiguous?: boolean };
  slabs: Slab[];
  verification: Verification;
  line_checks: { checked: number; failed: number };
  negative_lines?: { positions: number[]; status: NegativeLines["status"] };
  tax_regime?: TaxRegime; // supplier state vs place of supply: which tax heads are expected (CGST+SGST, CGST+UTGST or IGST)
  // Each GST head against the lines (tax-reconcile.ts). total_gst = CGST + SGST + UTGST + IGST, each head once; cess is not GST.
  tax_components?: {
    basis: "labelled_lines" | "supply_type" | "none";
    invoice: { cgst: number; sgst: number; utgst: number; igst: number; cess: number; total_gst: number };
    lines: { cgst: number; sgst: number; utgst: number; igst: number } | null;
    failed: string[]; // fields that disagree, e.g. ["utgst_amount"]
  };
  // Explicit adjustments, kept apart so a discount is never read as TCS / TDS and the printed figures reconcile as printed.
  adjustments?: {
    tcs: number; // INR, added after tax, inside the grand total (0 = none printed / not applied)
    tds: number; // INR, withheld from the payment, not inside the grand total
    tcs_tds_applied: boolean;
    discount: number | null; // INR, as printed
    discount_treatment: TotalsResult["discountTreatment"];
    round_off: number | null;
    net_payable_printed: number | null;
  };
}

export interface InvoiceValidation {
  valid: boolean; // no error or warning came out of the engine
  flags: ReviewFlag[];
  patch: { round_off_amount?: number }; // derived value the caller may save with source "computed"
  summary: ValidationSummary;
}

export function validateInvoice(data: InvoiceData, opts: EngineOptions): InvoiceValidation {
  const { extracted: e, items } = data;
  const ctx = { currency: e.currency, exchangeRate: e.exchange_rate, tolerancePaise: opts.tolerancePaise, rateTolerance: rateToleranceFor(e.field_status), rateFetched: e.field_status?.exchange_rate?.source === "fetched" };

  const lineFlags = checkLineItems(items, ctx);
  const alloc = validateTaxAllocation(e, items, opts.tolerancePaise);
  const totals = validateInvoiceTotals(e, items, opts);
  const meta = validateEInvoiceMetadata(e);
  const neg = validateNegativeLines(e, items, opts.tolerancePaise);
  const verification = tripleCheckTax(e, items, opts.tolerancePaise);
  const heads = checkTaxHeads(e, items, opts.tolerancePaise); // second layer: each tax head on its own (tax-math.ts)

  // Third layer: every GST head rebuilt from the lines on its own (tax-reconcile.ts), so a correct grand total never hides a wrong
  // breakdown. When the lines are labelled, alloc.flags already carries the head findings (with field / expected / observed / reason).
  const rec = reconcileTaxComponents(e, items, opts.tolerancePaise);
  const componentFlags: ReviewFlag[] = [];
  if (rec.lineTaxIncludesCess !== null) {
    componentFlags.push({
      code: "line_tax_includes_cess", severity: "info", field: "cess",
      message: `The tax printed on the item lines (GST + cess) includes the cess of INR ${rec.lineTaxIncludesCess.toFixed(2)}. The cess was taken out before the lines were compared with CGST / SGST / UTGST / IGST. No stored amount was changed.`,
      details: { cess: rec.lineTaxIncludesCess },
    });
  }
  if (rec.basis !== "labelled_lines" && rec.heads.length > 0) componentFlags.push(componentFlag("tax_component_mismatch", rec.heads));
  if (rec.cess) componentFlags.push(componentFlag("tax_component_mismatch", [rec.cess]));
  if (rec.totalGst) componentFlags.push(componentFlag("tax_component_mismatch", [rec.totalGst]));
  const failedFields = [...rec.heads, ...(rec.cess ? [rec.cess] : []), ...(rec.totalGst ? [rec.totalGst] : [])].map((f) => f.field);
  if (rec.heads.length > 0 || rec.totalGst) {
    // A matching grand total is not enough: when a head disagrees with the lines the tax cross-check is NOT verified.
    if (verification.level !== "unverified") verification.level = "unverified";
    if (!verification.disagreeing.includes("component_heads")) verification.disagreeing.push("component_heads");
  }

  const flags: ReviewFlag[] = [...lineFlags, ...totals.flags, ...alloc.flags, ...componentFlags, ...heads.flags, ...neg.flags, ...meta]; // the cross-check verdict is kept in the summary, not as a flag, so clean invoices stay flag-free
  // The tax cross-check above only compares three ways of adding up the TAX. It must never read "verified" while another financial
  // check of the same invoice failed: a wrong grand total, a wrong tax head or a wrong line must also downgrade it, whatever
  // confidence the model reported. (Before this, an invoice with a 1,500 total instead of 1,180 still showed level "verified".)
  const FINANCIAL_CODES = new Set(["tax_allocation_mismatch", "tax_component_mismatch", "cgst_sgst_unequal", "tax_head_mismatch"]);
  const financialFailures = flags.filter((f) => (f.severity === "error" || f.severity === "warning") && (f.code.startsWith("arithmetic_") || FINANCIAL_CODES.has(f.code)));
  if (totals.passed === false || financialFailures.length > 0) {
    if (verification.level === "verified" || verification.level === "partial") verification.level = "unverified";
    if (totals.passed === false && !verification.disagreeing.includes("grand_total")) verification.disagreeing.push("grand_total");
    if (financialFailures.length > 0 && !verification.disagreeing.includes("financial_checks")) verification.disagreeing.push("financial_checks");
  }
  const lineFails = lineFlags.filter((f) => f.code === "arithmetic_line_mismatch").length;
  const summary: ValidationSummary = {
    version: 1,
    currency: e.currency ?? "INR",
    exchange_rate: hasRate(e.exchange_rate) ? e.exchange_rate : 1,
    extracted_total: e.total_amount,
    calculated_total: totals.calculatedTotal,
    total_check: totals.passed === null ? "not_checked" : totals.passed ? "passed" : "failed",
    total_tier: totals.matchedTier,
    expected_grand_total: totals.expectedGrandTotal,
    expected_net_payable: totals.expectedNetPayable,
    round_off_applied: totals.roundOffApplied,
    tax_allocation: { method: alloc.method, mixed: alloc.mixed, ...(alloc.ambiguous !== undefined ? { ambiguous: alloc.ambiguous } : {}) },
    slabs: slabSummary(items, alloc.assignment),
    verification,
    line_checks: { checked: items.length, failed: lineFails },
    tax_regime: heads.regime,
    tax_components: {
      basis: rec.basis,
      invoice: { cgst: p(e.cgst_amount) / 100, sgst: p(e.sgst_amount) / 100, utgst: p(e.utgst_amount) / 100, igst: p(e.igst_amount) / 100, cess: p(e.cess_amount) / 100, total_gst: rec.totals.fromComponents },
      lines: rec.lineSplit ? { cgst: rec.lineSplit.cgst, sgst: rec.lineSplit.sgst, utgst: rec.lineSplit.utgst, igst: rec.lineSplit.igst } : null,
      failed: Array.from(new Set(failedFields)),
    },
    adjustments: {
      tcs: Math.abs(p(e.tcs_amount)) / 100, tds: Math.abs(p(e.tds_amount)) / 100,
      tcs_tds_applied: Math.abs(p(e.tcs_amount)) !== 0 || Math.abs(p(e.tds_amount)) !== 0,
      discount: e.discount_amount === null ? null : e.discount_amount,
      discount_treatment: totals.discountTreatment,
      round_off: has(e.round_off_amount) ? e.round_off_amount : null,
      net_payable_printed: has(e.net_payable_amount) ? e.net_payable_amount : null,
    },
    ...(neg.positions.length > 0 && neg.status !== "not_applicable" ? { negative_lines: { positions: neg.positions, status: neg.status } } : {}),
  };
  return {
    valid: !flags.some((f) => f.severity === "error" || f.severity === "warning"),
    flags,
    // A round-off printed on the invoice is never replaced by a computed one: the patch is only for an invoice that printed none.
    patch: totals.roundOffApplied !== null && !has(e.round_off_amount) ? { round_off_amount: totals.roundOffApplied } : {},
    summary,
  };
}
