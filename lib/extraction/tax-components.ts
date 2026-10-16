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
// Arithmetic is done in integer paise (toPaise() in normalize.ts), so sums of 2-decimal amounts carry no float noise.
import { toPaise } from "./normalize.ts";

export const MONEY_TOLERANCE_PAISE = 200; // INR 2.00: the documented round-off window (same as ROUND_OFF_MAX_PAISE in gst-engine.ts)

type Amt = number | null | undefined;
export interface TaxHeadsInput {
  cgst_amount?: Amt;
  sgst_amount?: Amt;
  utgst_amount?: Amt;
  igst_amount?: Amt;
  cess_amount?: Amt;
}

export const paise = (v: Amt): number => (v === null || v === undefined || !Number.isFinite(v) ? 0 : toPaise(v));
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

// ---- Line tax that already contains the cess ----------------------------------------------------------------------------
// Some invoices print a per-line "tax" figure (or a combined rate) that is GST + cess, e.g. CGST 12.875 % + SGST 12.875 % + cess 11.175 %.
// Cess is not GST: if such a line tax is read as CGST + SGST, every GST head comes out too high by half the cess.
// This is recognised ONLY when the evidence is exact, and nothing is changed in the stored data:
//   * a cess is printed at invoice level (above the rounding window),
//   * the line taxes add up to invoice GST + invoice cess (within the window) and NOT to the invoice GST alone,
//   * one tax family only (all CGST+SGST, all CGST+UTGST or all IGST): the cess then cannot move between heads, so the heads
//     rebuilt from the lines are exact. With mixed families the split of the cess is unknown and the mismatch stays visible.
// Anything else keeps the old behaviour, so a genuine tax error is still reported.
type LineLike = { applied_tax_type?: string | null };
type HeadsLike = TaxHeadsInput;

export function isCessInclusiveLineTotal(e: HeadsLike, items: LineLike[], lineTaxTotal: number, tolPaise: number): boolean {
  const H = taxHeadsPaise(e);
  const gst = totalGstPaise(H);
  if (H.cess <= tolPaise || gst <= 0) return false;
  if (Math.abs(lineTaxTotal - (gst + H.cess)) > tolPaise || Math.abs(lineTaxTotal - gst) <= tolPaise) return false;
  const families = new Set<string>();
  let unlabelled = false;
  for (const it of items) {
    const t = it.applied_tax_type;
    if (t === "NONE") continue;
    if (t === "IGST" || t === "CGST_SGST" || t === "CGST_UTGST") families.add(t); else unlabelled = true;
  }
  const mixedInvoice = H.igst !== 0 && (H.cgst !== 0 || stateTaxPaise(H) !== 0);
  if (families.size > 1) return false;
  if (unlabelled && mixedInvoice) return false;
  return true;
}

// Line taxes (paise) without the cess, or null when the lines do not show that pattern. Order and NONE lines are kept; the cess is
// taken out in proportion to each affected line and the rounding residue goes to the last one, so the lines still add up exactly.
// Two cases, both needing exact evidence:
//   1. one tax family on the invoice (see isCessInclusiveLineTotal);
//   2. several families (e.g. IGST lines + CGST/SGST lines): the lines of EVERY family must reproduce their invoice head, except exactly
//      one family whose lines are higher by exactly the printed cess. Only that family's lines carry the cess. If the cess is spread over
//      several families, or the difference is anything else, nothing is adjusted and the mismatch stays visible.
export function removeCessFromLineTaxes(e: HeadsLike, items: LineLike[], taxes: (number | null)[], tolPaise: number): { taxes: (number | null)[]; cess: number } | null {
  if (items.length === 0 || taxes.some((t) => t === null || t === undefined)) return null;
  const H = taxHeadsPaise(e);
  if (H.cess <= tolPaise) return null;
  const idx = items.map((_, i) => i).filter((i) => items[i].applied_tax_type !== "NONE" && (taxes[i] as number) !== 0);
  const total = idx.reduce((a, i) => a + (taxes[i] as number), 0);
  // Takes the cess out of `lines` in proportion to each line's tax. A family whose lines add up to 0 (e.g. a credit line cancelling a
  // debit line) has no proportion to split by: dividing by 0 would turn every line into +/-Infinity or NaN, so nothing is adjusted
  // (null) and the mismatch stays visible instead.
  const strip = (lines: number[], sum: number): (number | null)[] | null => {
    if (!Number.isFinite(sum) || sum === 0) return null;
    const target = sum - H.cess;
    const out = [...taxes];
    let used = 0;
    lines.forEach((i, n) => {
      const v = n === lines.length - 1 ? target - used : Math.round(((taxes[i] as number) * target) / sum);
      out[i] = v;
      used += v;
    });
    return out.every((t) => t === null || Number.isFinite(t)) ? out : null;
  };
  if (isCessInclusiveLineTotal(e, items, total, tolPaise)) {
    const adjusted = strip(idx, total);
    return adjusted ? { taxes: adjusted, cess: H.cess } : null;
  }

  // Several families: the lines must all be labelled and the grand sum must be GST + cess.
  const gst = totalGstPaise(H);
  if (gst <= 0 || Math.abs(total - (gst + H.cess)) > tolPaise) return null;
  const FAMILIES = ["IGST", "CGST_SGST", "CGST_UTGST"] as const;
  if (idx.some((i) => !(FAMILIES as readonly string[]).includes(String(items[i].applied_tax_type)))) return null;
  const present = FAMILIES.filter((fam) => idx.some((i) => items[i].applied_tax_type === fam));
  if (present.length < 2) return null;
  if (present.includes("CGST_UTGST") && !known(e.utgst_amount)) return null; // legacy rows keep the state tax in SGST: head per family unknown
  // What each family's lines should add up to, from the invoice heads (SGST / UTGST are each half of their family's tax).
  const expected: Record<string, number> = { IGST: H.igst, CGST_SGST: 2 * H.sgst, CGST_UTGST: 2 * H.utgst };
  const sums: Record<string, number> = {};
  for (const fam of present) sums[fam] = idx.filter((i) => items[i].applied_tax_type === fam).reduce((a, i) => a + (taxes[i] as number), 0);
  const off = present.filter((fam) => Math.abs(sums[fam] - expected[fam]) > tolPaise);
  if (off.length !== 1) return null;
  const fam = off[0];
  if (Math.abs(sums[fam] - expected[fam] - H.cess) > tolPaise) return null;
  const adjusted = strip(idx.filter((i) => items[i].applied_tax_type === fam), sums[fam]);
  return adjusted ? { taxes: adjusted, cess: H.cess } : null;
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
