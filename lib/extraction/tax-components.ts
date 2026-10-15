// Single source of truth for the GST heads of ONE invoice. Every verification layer, the review screen, the exports and the
// Tally voucher read the tax heads through this module, so they all add up the same way.
//
// Heads (each its own authoritative money field, never merged):
//   cgst_amount   Central GST
//   sgst_amount   State GST                      (legacy rows: may hold UTGST when utgst_amount is null, see below)
//   utgst_amount  Union Territory GST            (added in migration 014, optional: older rows and older readings have none)
//   igst_amount   Integrated GST
//   cess_amount   Cess (not GST, reported next to it)
//
// Legacy behaviour: before utgst_amount existed, a UT supply was stored in sgst_amount and labelled "SGST / UTGST".
// Those rows keep working: the state-level tax of an invoice is ALWAYS sgst + utgst, and a null utgst counts as 0, so an
// old row is never double counted and never loses its amount. When BOTH heads are printed they are two separate amounts
// and both are added. Nothing here ever changes a stored value.
//
// Arithmetic is done in integer paise (Math.round(x * 100)), so sums of 2-decimal amounts carry no float noise.

export const MONEY_TOLERANCE_PAISE = 200; // INR 2.00: the documented round-off window (same as ROUND_OFF_MAX_PAISE in gst-engine.ts)

type Amt = number | null | undefined;
export interface TaxHeadsInput {
  cgst_amount?: Amt;
  sgst_amount?: Amt;
  utgst_amount?: Amt;
  igst_amount?: Amt;
  cess_amount?: Amt;
}

export const paise = (v: Amt): number => (v === null || v === undefined || !Number.isFinite(v) ? 0 : Math.round(v * 100));
export const known = (v: Amt): v is number => v !== null && v !== undefined;

export interface TaxHeadsPaise {
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
  cess: number;
}

export function taxHeadsPaise(e: TaxHeadsInput): TaxHeadsPaise {
  return { cgst: paise(e.cgst_amount), sgst: paise(e.sgst_amount), utgst: paise(e.utgst_amount), igst: paise(e.igst_amount), cess: paise(e.cess_amount) };
}

// State-level tax: SGST plus UTGST (each counted once).
export const stateTaxPaise = (h: TaxHeadsPaise): number => h.sgst + h.utgst;
// Total GST = CGST + SGST + UTGST + IGST. Cess is NOT GST and is added separately.
export const totalGstPaise = (h: TaxHeadsPaise): number => h.cgst + h.sgst + h.utgst + h.igst;
// Everything that is added on top of the taxable value as tax: total GST + cess.
export const totalTaxPaise = (h: TaxHeadsPaise): number => totalGstPaise(h) + h.cess;

// True when at least one GST head was read at all (null everywhere = nothing to calculate with).
export const anyGstHeadKnown = (e: TaxHeadsInput): boolean => [e.cgst_amount, e.sgst_amount, e.utgst_amount, e.igst_amount].some(known);
// True when the invoice carries a non-zero state-level head (SGST or UTGST).
export const hasStateTax = (e: TaxHeadsInput): boolean => paise(e.sgst_amount) !== 0 || paise(e.utgst_amount) !== 0;

// Label for the state-level tax on screen: names the head(s) that actually carry an amount.
export function stateTaxLabel(e: TaxHeadsInput): string {
  const s = paise(e.sgst_amount) !== 0, u = paise(e.utgst_amount) !== 0;
  if (s && u) return "SGST + UTGST";
  if (u) return "UTGST";
  if (s) return "SGST";
  return "SGST / UTGST";
}

// ---- Line level --------------------------------------------------------------------------------------------------------
// applied_tax_type of a line: the head family it carries.
export type LineTaxType = "IGST" | "CGST_SGST" | "CGST_UTGST" | "NONE";

export interface LineTaxSplit {
  igst: number; // paise
  cgst: number;
  sgst: number;
  utgst: number;
  unlabelled: number; // tax on lines whose type is unknown
}

// Splits the printed line taxes by head. CGST_SGST and CGST_UTGST lines carry half CGST and half state tax.
export function splitLineTaxes(items: { applied_tax_type?: LineTaxType | "AMOUNT" | string | null }[], taxes: (number | null)[]): LineTaxSplit {
  const out: LineTaxSplit = { igst: 0, cgst: 0, sgst: 0, utgst: 0, unlabelled: 0 };
  items.forEach((it, i) => {
    const t = taxes[i];
    if (t === null || t === undefined) return;
    switch (it.applied_tax_type) {
      case "IGST": out.igst += t; break;
      case "CGST_SGST": out.cgst += t / 2; out.sgst += t / 2; break;
      case "CGST_UTGST": out.cgst += t / 2; out.utgst += t / 2; break;
      case "NONE": break;
      default: out.unlabelled += t;
    }
  });
  return out;
}

// ---- Reconciliation ----------------------------------------------------------------------------------------------------
export interface HeadDiscrepancy {
  head: "CGST" | "SGST" | "UTGST" | "IGST" | "CESS" | "TOTAL_GST";
  invoice: number; // INR printed on the invoice
  lines: number; // INR the lines add up to
  difference: number; // INR, invoice - lines
}

// Compares invoice-level heads with the sum of the lines, head by head. Returns one entry per head that disagrees.
export function reconcileHeads(invoice: TaxHeadsPaise, lines: LineTaxSplit, tolPaise: number): HeadDiscrepancy[] {
  const rows: [HeadDiscrepancy["head"], number, number][] = [
    ["IGST", invoice.igst, lines.igst], ["CGST", invoice.cgst, lines.cgst], ["SGST", invoice.sgst, lines.sgst], ["UTGST", invoice.utgst, lines.utgst],
  ];
  const out: HeadDiscrepancy[] = [];
  for (const [head, inv, ln] of rows) {
    if (Math.abs(inv - ln) > tolPaise) out.push({ head, invoice: inv / 100, lines: ln / 100, difference: (inv - ln) / 100 });
  }
  return out;
}
