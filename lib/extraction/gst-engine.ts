// GST validation engine: ONE entry point, validateInvoice(), built from small independent algorithms.
// Nothing here changes an extracted value. It only returns flags, a summary, and (for round-off) a derived value
// that the caller may save with source "computed".
//
// Every important figure is checked by more than one independent method ("triple check"):
//   line level   : validateLineItem()       qty x price - discount, x exchange rate        (arithmetic.ts)
//   tax level    : validateTaxAllocation()  per-line IGST / CGST / SGST sums vs the invoice (Rule 2, mixed tax)
//   total level  : validateInvoiceTotals()  universal grand-total formula incl. TCS, TDS, charges, round-off (Rule 3)
//   cross check  : tripleCheckTax()         printed header tax  vs  printed line tax  vs  rate x taxable  vs  state rule
// An invoice is shown as "verified" only when every method that could run agrees. Disagreement is never hidden.
import { checkLineItems, hasRate, isForeign } from "./arithmetic.ts";
import { describeIdentifierProblem, isValidAckNo, isValidEwayBill, isValidIrn } from "./identifiers.ts";
import { toPaise } from "./normalize.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export { validateLineItem } from "./arithmetic.ts";

// A difference up to this (INR 2.00) is absorbed into round_off_amount and the total check PASSES.
export const ROUND_OFF_MAX_PAISE = 200;
const RATE_REL_TOLERANCE = 0.0005;
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

export type TaxType = "IGST" | "CGST_SGST" | "NONE";

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
  flags: ReviewFlag[];
}

export function validateTaxAllocation(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): TaxAllocation {
  const flags: ReviewFlag[] = [];
  const igstH = p(e.igst_amount), cgstH = p(e.cgst_amount), sgstH = p(e.sgst_amount);
  const mixed = nonZero(e.igst_amount) && (nonZero(e.cgst_amount) || nonZero(e.sgst_amount));
  const tol = tolerancePaise + Math.min(items.length, 200); // each line's tax is rounded to the paisa
  const out = (method: TaxAllocation["method"], extra: Partial<TaxAllocation> = {}): TaxAllocation => ({ method, mixed, lineIgst: 0, lineCgst: 0, lineSgst: 0, flags, ...extra });
  const taxes = items.map(lineTaxPaise);
  const known = items.length > 0 && taxes.every((t) => t !== null);
  const labelled = items.length > 0 && items.every((it) => it.applied_tax_type === "IGST" || it.applied_tax_type === "CGST_SGST" || it.applied_tax_type === "NONE");

  if (labelled && known) {
    let sumIgst = 0, sumCs = 0;
    items.forEach((it, i) => {
      if (it.applied_tax_type === "IGST") sumIgst += taxes[i] as number;
      else if (it.applied_tax_type === "CGST_SGST") sumCs += taxes[i] as number;
    });
    const half = sumCs / 2;
    const bad: string[] = [];
    if (Math.abs(sumIgst - igstH) > tol) bad.push("IGST");
    if (Math.abs(half - cgstH) > tol) bad.push("CGST");
    if (Math.abs(half - sgstH) > tol) bad.push("SGST");
    if (bad.length > 0) {
      flags.push({
        code: "tax_allocation_mismatch", severity: "warning",
        message: `The ${bad.join(", ")} of the individual lines does not add up to the invoice ${bad.join(", ")}. Check the original.`,
        details: { lineIgst: sumIgst / 100, lineCgst: half / 100, lineSgst: half / 100, invoiceIgst: igstH / 100, invoiceCgst: cgstH / 100, invoiceSgst: sgstH / 100 },
      });
    } else if (mixed) {
      flags.push({ code: "mixed_tax_invoice", severity: "info", message: "IGST and CGST/SGST are both charged. This is allowed when different lines carry different taxes, and every line adds up." });
    }
    return out("labelled", { lineIgst: sumIgst / 100, lineCgst: half / 100, lineSgst: half / 100 });
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
    if (Math.abs(sumIgst - igstH) <= tol && Math.abs(half - cgstH) <= tol && Math.abs(half - sgstH) <= tol) solutions.push(mask);
  }
  if (solutions.length === 0) {
    flags.push({
      code: "mixed_tax_unreconciled", severity: "warning",
      message: "IGST and CGST/SGST are both charged and no split of the line items reproduces them. Check the original.",
      details: { invoiceIgst: igstH / 100, invoiceCgst: cgstH / 100, invoiceSgst: sgstH / 100 },
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

// ---- Rule 3: grand total, taxable base, pre-tax charges, TCS / TDS, round-off -----------------------------------------

export interface TotalsResult {
  flags: ReviewFlag[];
  passed: boolean | null; // null = not enough values to check
  calculatedTotal: number | null; // INR, from the universal formula
  roundOffApplied: number | null; // INR, set only when a difference was absorbed
}

export function validateInvoiceTotals(e: StoredExtracted, items: StoredItem[], opts: EngineOptions): TotalsResult {
  const flags: ReviewFlag[] = [];
  const tol = opts.tolerancePaise;
  const fs = e.field_status ?? {};
  const foreignRate = isForeign(e.currency, e.exchange_rate) && hasRate(e.exchange_rate) ? e.exchange_rate : null;
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
  if (total === null || base0 === null) return { flags, passed: null, calculatedTotal: null, roundOffApplied: null };

  const tax = p(e.cgst_amount) + p(e.sgst_amount) + p(e.igst_amount) + p(e.cess_amount);
  const tcs = p(e.tcs_amount), tds = p(e.tds_amount);
  const printedRo = has(e.round_off_amount) ? toPaise(e.round_off_amount) : 0;
  const disc = e.discount_amount !== null ? toPaise(e.discount_amount) : null;
  const actual = toPaise(total);

  // Calculated Total = Taxable + CGST + SGST + IGST + Cess + TCS - TDS (+/- Round off)
  const formula = (base: number) => base + tax + tcs - tds;
  const bases = [base0];
  if (charges !== null) bases.push(base0 + charges); // charges only added to the taxable base, not inside it
  const variants: { value: number; rel: number }[] = [];
  for (const b of bases) {
    variants.push({ value: formula(b), rel: 0 });
    if (disc !== null) variants.push({ value: formula(b) - disc, rel: 0 });
  }
  if (foreignRate !== null) variants.push({ value: Math.round(formula(base0) / foreignRate), rel: RATE_REL_TOLERANCE }); // total printed in the foreign currency
  // Credit / debit notes and returns: the printed total can carry the opposite sign.
  const signed = variants.flatMap((v) => (actual < 0 !== v.value < 0 && actual !== 0 ? [v, { ...v, value: -v.value }] : [v]));

  const absorbMax = Math.max(tol, ROUND_OFF_MAX_PAISE);
  let best: { diff: number; value: number; rel: number } | null = null;
  for (const v of signed) {
    const diff = actual - v.value;
    // Distance after accounting for a printed round-off; the closest reading wins.
    const dist = v.rel === 0 ? Math.min(Math.abs(diff - printedRo), Math.abs(diff)) : Math.max(0, Math.abs(diff) - Math.round(Math.abs(v.value) * v.rel));
    if (best === null || dist < Math.min(Math.abs(best.diff - printedRo), Math.abs(best.diff))) best = { diff, value: v.value, rel: v.rel };
  }
  const primary = formula(base0);
  const b = best as { diff: number; value: number; rel: number };

  if (b.rel > 0) {
    if (Math.abs(b.diff) <= tol + Math.round(Math.abs(b.value) * b.rel)) return { flags, passed: true, calculatedTotal: primary / 100, roundOffApplied: null };
  } else if (printedRo !== 0 && Math.abs(b.diff - printedRo) <= tol) {
    return { flags, passed: true, calculatedTotal: (b.value + printedRo) / 100, roundOffApplied: null }; // the printed round-off explains the difference
  } else if (Math.abs(b.diff) <= absorbMax) {
    if (b.diff === 0) return { flags, passed: true, calculatedTotal: b.value / 100, roundOffApplied: null };
    // Difference of up to INR 2.00: absorbed into round_off_amount, total check PASSES. Normal rounding (within the soft
    // tolerance) is silent; a larger absorbed difference leaves an info note so nobody is surprised by it.
    if (Math.abs(b.diff) > tol) flags.push({
      code: "round_off_absorbed", severity: "info", field: "round_off_amount",
      message: `A difference of INR ${(b.diff / 100).toFixed(2)} between the calculated and the printed grand total was recorded as round-off.`,
      details: { calculated: b.value / 100, extracted: actual / 100, roundOff: b.diff / 100, ...(printedRo !== 0 ? { printedRoundOff: printedRo / 100 } : {}) },
    });
    return { flags, passed: true, calculatedTotal: b.value / 100, roundOffApplied: b.diff / 100 };
  }

  const absent = (["cgst", "sgst", "igst", "cess"] as const).filter((k) => fs[k]?.state === "missing");
  flags.push({
    code: "arithmetic_total_mismatch", severity: "error", field: "grand_total",
    message: "Taxable value plus taxes does not equal the grand total.",
    details: {
      expected: primary / 100, extracted: actual / 100, taxFieldsNotFound: absent,
      ...(header === null ? { taxableFromItems: true } : {}),
      ...(tcs !== 0 ? { tcs: tcs / 100 } : {}), ...(tds !== 0 ? { tds: tds / 100 } : {}), ...(charges !== null ? { preTaxCharges: charges / 100 } : {}),
    },
  });
  return { flags, passed: false, calculatedTotal: primary / 100, roundOffApplied: null };
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
  const headerKnown = [e.cgst_amount, e.sgst_amount, e.igst_amount].some(has);
  if (!headerKnown) return { level: "not_checked", methods, disagreeing: [] };
  const header = p(e.cgst_amount) + p(e.sgst_amount) + p(e.igst_amount);
  methods.push({ id: "printed_invoice_tax", label: "CGST + SGST + IGST printed on the invoice", value: header / 100 });
  if (items.length > 0 && items.every((it) => has(it.gst_amount))) {
    methods.push({ id: "printed_line_tax", label: "Sum of the tax printed on each line", value: items.reduce((a, it) => a + p(it.gst_amount), 0) / 100 });
  }
  if (items.length > 0 && items.every((it) => has(it.gst_rate) && has(it.taxable_amount))) {
    methods.push({ id: "rate_x_taxable", label: "Taxable value x GST rate, line by line", value: items.reduce((a, it) => a + toPaise(((it.taxable_amount as number) * (it.gst_rate as number)) / 100), 0) / 100 });
  }
  const disagreeing: string[] = [];
  for (const m of methods.slice(1)) if (Math.abs(toPaise(m.value) - header) > tol) disagreeing.push(m.id);

  // Fourth, rule-based method: supplier state vs place of supply decides which tax head is expected.
  const sup = stateOf(e.vendor_gstin, "gstin"), pos = stateOf(e.place_of_supply, "place");
  const mixed = nonZero(e.igst_amount) && (nonZero(e.cgst_amount) || nonZero(e.sgst_amount));
  if (sup && pos && pos !== "96" && pos !== "97" && !mixed && header !== 0) {
    const intra = sup === pos;
    const ok = intra ? !nonZero(e.igst_amount) : !(nonZero(e.cgst_amount) || nonZero(e.sgst_amount));
    methods.push({ id: "state_rule", label: intra ? "Same state: CGST + SGST expected" : "Different states: IGST expected", value: header / 100 });
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
  round_off_applied: number | null;
  tax_allocation: { method: TaxAllocation["method"]; mixed: boolean; ambiguous?: boolean };
  slabs: Slab[];
  verification: Verification;
  line_checks: { checked: number; failed: number };
  negative_lines?: { positions: number[]; status: NegativeLines["status"] };
}

export interface InvoiceValidation {
  valid: boolean; // no error or warning came out of the engine
  flags: ReviewFlag[];
  patch: { round_off_amount?: number }; // derived value the caller may save with source "computed"
  summary: ValidationSummary;
}

export function validateInvoice(data: InvoiceData, opts: EngineOptions): InvoiceValidation {
  const { extracted: e, items } = data;
  const ctx = { currency: e.currency, exchangeRate: e.exchange_rate, tolerancePaise: opts.tolerancePaise };

  const lineFlags = checkLineItems(items, ctx);
  const alloc = validateTaxAllocation(e, items, opts.tolerancePaise);
  const totals = validateInvoiceTotals(e, items, opts);
  const meta = validateEInvoiceMetadata(e);
  const neg = validateNegativeLines(e, items, opts.tolerancePaise);
  const verification = tripleCheckTax(e, items, opts.tolerancePaise);

  const flags: ReviewFlag[] = [...lineFlags, ...totals.flags, ...alloc.flags, ...neg.flags, ...meta]; // the cross-check verdict is kept in the summary, not as a flag, so clean invoices stay flag-free
  const lineFails = lineFlags.filter((f) => f.code === "arithmetic_line_mismatch").length;
  const summary: ValidationSummary = {
    version: 1,
    currency: e.currency ?? "INR",
    exchange_rate: hasRate(e.exchange_rate) ? e.exchange_rate : 1,
    extracted_total: e.total_amount,
    calculated_total: totals.calculatedTotal,
    total_check: totals.passed === null ? "not_checked" : totals.passed ? "passed" : "failed",
    round_off_applied: totals.roundOffApplied,
    tax_allocation: { method: alloc.method, mixed: alloc.mixed, ...(alloc.ambiguous !== undefined ? { ambiguous: alloc.ambiguous } : {}) },
    slabs: slabSummary(items, alloc.assignment),
    verification,
    line_checks: { checked: items.length, failed: lineFails },
    ...(neg.positions.length > 0 && neg.status !== "not_applicable" ? { negative_lines: { positions: neg.positions, status: neg.status } } : {}),
  };
  return {
    valid: !flags.some((f) => f.severity === "error" || f.severity === "warning"),
    flags,
    patch: totals.roundOffApplied !== null ? { round_off_amount: totals.roundOffApplied } : {},
    summary,
  };
}
