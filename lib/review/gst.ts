// GST-aware review checks. They only ADD flags for a person to look at. They never change a value.
//
// Covered: CGST+SGST (same state) vs IGST (different states), CGST = SGST, tax charged without a supplier GSTIN,
// tax on a bill of supply, no tax charged, item rate vs item tax, item rates vs invoice tax, unusual rates.
// TCS, TDS, round-off, pre-tax charges, mixed IGST + CGST/SGST and e-invoice metadata are handled by gst-engine.ts.
// Not modelled: reverse charge, composition-scheme specifics. See docs/GST_ENGINE.md.
import { toPaise } from "../extraction/normalize.ts";
import { checkGstRate, rateDateNote, ALL_GST_RATES } from "../gst/rates.ts";
import { isIntraStateSupply, isSezSupply, NAME_ALIASES, sameStateCode, STATE_NAMES } from "../gst/states.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "../extraction/types.ts";

// State table, aliases, UTGST set and the SEZ rule live in lib/gst/states.ts; the rate list in lib/gst/rates.ts (one copy each).
export { STATE_NAMES };
export const COMMON_GST_RATES: readonly number[] = ALL_GST_RATES;

function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const NAME_INDEX: [string, string][] = [
  ...Object.entries(STATE_NAMES).filter(([c]) => c < "96").map(([c, n]) => [norm(n), c] as [string, string]),
  ...Object.entries(NAME_ALIASES).map(([n, c]) => [norm(n), c] as [string, string]),
].sort((a, b) => b[0].length - a[0].length); // longest name first so "Andhra Pradesh" never loses to a shorter match

// State code from a place-of-supply text such as "Maharashtra (27)", "27-Maharashtra" or "Karnataka".
export function stateCodeFromPlace(text: string | null): string | null {
  if (!text) return null;
  const paren = /\((\d{2})\)/.exec(text) ?? /^\s*(\d{2})\b/.exec(text) ?? /\b(\d{2})\s*[-–]/.exec(text);
  if (paren && STATE_NAMES[paren[1]]) return paren[1];
  const n = norm(text);
  for (const [name, code] of NAME_INDEX) {
    if (name && (n === name || n.includes(` ${name} `) || n.startsWith(`${name} `) || n.endsWith(` ${name}`))) return code;
  }
  return null;
}

export function stateCodeFromGstin(gstin: string | null): string | null {
  if (!gstin || gstin.length < 2) return null;
  const c = gstin.slice(0, 2);
  return /^\d{2}$/.test(c) && STATE_NAMES[c] ? c : null;
}

const nz = (v: number | null | undefined): number => v ?? 0;
const nonZero = (v: number | null | undefined): boolean => v !== null && v !== undefined && v !== 0;

export interface GstOptions {
  tolerancePaise: number;
}

type Doc = Pick<
  StoredExtracted,
  "document_type" | "vendor_gstin" | "place_of_supply" | "taxable_amount" | "total_amount" | "cgst_amount" | "sgst_amount" | "utgst_amount" | "igst_amount" | "cess_amount"
> & { invoice_date?: string | null; buyer_name?: string | null };

export function gstChecks(doc: Doc, items: StoredItem[], opts: GstOptions): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const tol = opts.tolerancePaise;
  const type = doc.document_type;
  const taxAmounts = [doc.cgst_amount, doc.sgst_amount, doc.utgst_amount, doc.igst_amount];
  const anyTax = taxAmounts.some(nonZero);
  const hasIgst = nonZero(doc.igst_amount);
  const hasCgstSgst = nonZero(doc.cgst_amount) || nonZero(doc.sgst_amount) || nonZero(doc.utgst_amount); // SGST or UTGST

  // 1. Place of supply vs supplier state decides CGST+SGST or IGST.
  const supplierState = stateCodeFromGstin(doc.vendor_gstin);
  const pos = stateCodeFromPlace(doc.place_of_supply);
  const special = pos === "96" || pos === "97"; // exports, other territory: tax treatment differs, no intra/inter rule applied
  // A supply to an SEZ is IGST even inside one state (see isSezSupply in lib/gst/states.ts), and 25 / 26 are one UT.
  const sez = isSezSupply({ place_of_supply: doc.place_of_supply, buyer_name: doc.buyer_name });
  if (supplierState && pos && !special) {
    const intra = isIntraStateSupply(supplierState, pos, sez) === true;
    if (intra && hasIgst && !hasCgstSgst) {
      flags.push({
        code: "gst_type_mismatch", severity: "warning", field: "igst",
        message: `Supplier and place of supply are both ${STATE_NAMES[pos]}, so CGST and SGST are normally charged. IGST was charged. Check the original.`,
        details: { supplierState, placeOfSupplyState: pos },
      });
    }
    if (!intra && hasCgstSgst && !hasIgst) {
      const sezSameState = sez && sameStateCode(supplierState, pos);
      flags.push({
        code: "gst_type_mismatch", severity: "warning", field: "cgst",
        message: sezSameState
          ? `This is a supply to an SEZ, which is charged IGST even inside ${STATE_NAMES[supplierState]}. CGST/SGST was charged. Check the original.`
          : `Supplier is in ${STATE_NAMES[supplierState]} and the place of supply is ${STATE_NAMES[pos]}, so IGST is normally charged. CGST/SGST was charged. Check the original.`,
        details: { supplierState, placeOfSupplyState: pos, ...(sez ? { sez: true } : {}) },
      });
    }
  } else if (anyTax && type !== "bill_of_supply" && !special) {
    flags.push({
      code: "supply_type_unknown", severity: "info",
      message: "The supplier state or place of supply could not be determined, so CGST/SGST versus IGST could not be checked. Check it manually.",
    });
  }

  // 2. CGST equals the state-level tax (SGST + UTGST, each its own amount) on an intra-state supply. Compared as a SUM, so an
  // invoice with SGST lines and UTGST lines does not raise a false alarm, and SGST alone is never forced to equal CGST.
  if (doc.cgst_amount !== null && ((doc.sgst_amount ?? null) !== null || (doc.utgst_amount ?? null) !== null) && nonZero(doc.cgst_amount) && (nonZero(doc.sgst_amount) || nonZero(doc.utgst_amount))) {
    const state = toPaise(doc.sgst_amount ?? 0) + toPaise(doc.utgst_amount ?? 0);
    if (Math.abs(toPaise(doc.cgst_amount) - state) > Math.min(tol, 100)) {
      flags.push({
        code: "cgst_sgst_unequal", severity: "warning", field: "cgst",
        message: `${nonZero(doc.utgst_amount) ? "SGST + UTGST" : "SGST"}: expected INR ${(toPaise(doc.cgst_amount) / 100).toFixed(2)} (equal to CGST), found INR ${(state / 100).toFixed(2)}. ${nonZero(doc.utgst_amount) ? "CGST differs from SGST + UTGST. They are normally equal." : "CGST and SGST amounts differ. They are normally equal."}`,
        details: {
          cgst: doc.cgst_amount, sgst: doc.sgst_amount, utgst: doc.utgst_amount ?? null, stateTax: state / 100,
          field: "sgst", expected: toPaise(doc.cgst_amount) / 100, observed: state / 100, reason: "CGST must equal the state-level tax (SGST + UTGST).",
        },
      });
    }
  }

  // 3. Tax charged by someone with no GSTIN, or on a bill of supply.
  if (anyTax && !doc.vendor_gstin) {
    flags.push({ code: "tax_without_gstin", severity: "warning", field: "supplier_gstin", message: "GST is charged but no supplier GSTIN is recorded. Check the original." });
  }
  if (type === "bill_of_supply" && anyTax) {
    flags.push({ code: "tax_on_bill_of_supply", severity: "warning", message: "This is marked as a bill of supply, which normally carries no GST, but GST amounts are present." });
  }

  // 4. No tax at all on a tax invoice: legitimate for exempt, nil-rated, zero-rated or composition supplies, so INFO only.
  if (type === "tax_invoice" && !anyTax && doc.taxable_amount !== null && doc.total_amount !== null && !items.some((it) => nonZero(it.gst_rate))) {
    flags.push({ code: "no_tax_charged", severity: "info", message: "No GST is charged on this tax invoice. That is normal for exempt, nil-rated, zero-rated or composition supplies. Confirm it is correct." });
  }

  // 5. Item rates against item tax amounts and against the invoice tax.
  let allRated = items.length > 0;
  let expectedTotal = 0;
  items.forEach((it, i) => {
    const rate = it.gst_rate;
    if (rate !== null) {
      // Date-aware (lib/gst/rates.ts): 12% / 28% on an invoice dated on or after 22 Sep 2025 is a WARNING, any other odd rate stays INFO.
      const verdict = checkGstRate(rate, doc.invoice_date ?? null);
      if (verdict === "retired" || verdict === "not_yet") {
        flags.push({ code: "gst_rate_date_mismatch", severity: "warning", field: "gst_rate", itemPosition: i + 1, message: rateDateNote(verdict, rate), details: { rate, invoiceDate: doc.invoice_date ?? null, verdict } });
      } else if (verdict === "unknown") {
        flags.push({ code: "unusual_gst_rate", severity: "info", field: "gst_rate", itemPosition: i + 1, message: rateDateNote(verdict, rate) });
      }
    }
    if (rate === null || it.taxable_amount === null) {
      allRated = false;
      return;
    }
    const expected = toPaise((it.taxable_amount * rate) / 100);
    expectedTotal += expected;
    if (it.gst_amount !== null && Math.abs(toPaise(it.gst_amount) - expected) > tol) {
      flags.push({
        code: "item_tax_rate_mismatch", severity: "warning", field: "tax_amount", itemPosition: i + 1,
        message: "The item's GST amount does not match its taxable value at the stated rate.",
        details: { expected: expected / 100, extracted: it.gst_amount, rate },
      });
    }
  });

  if (allRated) {
    const headerTax = toPaise(nz(doc.cgst_amount)) + toPaise(nz(doc.sgst_amount)) + toPaise(nz(doc.utgst_amount)) + toPaise(nz(doc.igst_amount));
    const headerKnown = taxAmounts.some((v) => v !== null && v !== undefined);
    if (headerKnown && Math.abs(headerTax - expectedTotal) > tol) {
      flags.push({
        code: "invoice_tax_rate_mismatch", severity: "warning",
        message: "The invoice's CGST + SGST + UTGST + IGST does not match the item taxable values at their stated rates.",
        details: { expected: expectedTotal / 100, extracted: headerTax / 100 },
      });
    }
  } else if (items.every((it) => it.gst_rate === null) && doc.taxable_amount && doc.taxable_amount > 0 && anyTax) {
    // No item rates: look at the effective rate of the whole invoice.
    const tax = nz(doc.cgst_amount) + nz(doc.sgst_amount) + nz(doc.utgst_amount) + nz(doc.igst_amount);
    const effective = (tax / doc.taxable_amount) * 100;
    if (!COMMON_GST_RATES.some((r) => Math.abs(r - effective) <= 0.15)) {
      flags.push({
        code: "effective_rate_unusual", severity: "info",
        message: `The overall tax rate works out to about ${effective.toFixed(2)}%, which is not a common GST rate. Items may have mixed rates, or an amount may be wrong.`,
        details: { effectiveRate: Math.round(effective * 100) / 100 },
      });
    }
  }

  return flags;
}
