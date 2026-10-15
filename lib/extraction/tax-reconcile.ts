// Component-specific tax reconciliation. Each GST head is rebuilt from the invoice lines on its own and compared with the
// figure printed at invoice level, so a correct grand total can never hide a wrong tax breakdown.
//
//   IGST    against the lines charged IGST
//   CGST    against the CGST share of every CGST+SGST line AND every CGST+UTGST line (so CGST is the aggregate of both)
//   SGST    against the SGST share of the CGST+SGST lines only
//   UTGST   against the UTGST share of the CGST+UTGST lines only
//   Cess    against the cess the line totals imply (only when the lines carry a total that includes it)
//   Total GST (CGST + SGST + UTGST + IGST, each head once) against the tax of all lines
//
// CGST is never compared with SGST alone: an invoice with SGST lines and UTGST lines has CGST = SGST + UTGST.
// Every finding names the field, the expected value, the observed value and the reason, so a reviewer knows what to look at.
// Nothing here changes a value and nothing is hard coded: the figures come from the invoice being checked.
import { isForeign, hasRate } from "./arithmetic.ts";
import { anyGstHeadKnown, hasStateTax, known, paise, removeCessFromLineTaxes, splitLineTaxes, taxHeadsPaise, type LineTaxSplit } from "./tax-components.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export type ComponentField = "igst" | "cgst" | "sgst" | "utgst_amount" | "cess" | "total_gst";

export interface ComponentFinding {
  code: string; // specific diagnosis, e.g. utgst_missing, utgst_merged_into_sgst, cgst_mismatch
  field: ComponentField; // same keys the review screen and field_status use
  label: string;
  expected: number; // INR
  observed: number; // INR
  difference: number; // INR, observed - expected
  reason: string;
  lines?: { position: number; taxable: number | null; rate: number | null; tax: number }[]; // the lines behind an IGST figure (INR), so a reviewer sees each one
}

export interface ComponentReconciliation {
  basis: "labelled_lines" | "supply_type" | "none"; // what the lines were split by (none = lines could not be split)
  heads: ComponentFinding[]; // IGST / CGST / SGST / UTGST disagreements
  cess: ComponentFinding | null;
  totalGst: ComponentFinding | null; // only set when no single head explains it
  lineSplit: { igst: number; cgst: number; sgst: number; utgst: number } | null; // INR
  totals: { fromComponents: number; fromLines: number | null }; // INR, total GST both ways
  lineTaxIncludesCess: number | null; // INR of cess found inside the printed line taxes (and taken out), else null
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const nz = (v: number | null | undefined): boolean => has(v) && v !== 0;
const r2 = (p: number): number => Math.round(p) / 100;
const inr = (v: number): string => `INR ${v.toFixed(2)}`;
const LABELLED = new Set(["IGST", "CGST_SGST", "CGST_UTGST", "NONE"]);

// Tax of one line in paise: the printed amount, else taxable x rate.
function lineTax(it: StoredItem): number | null {
  if (has(it.gst_amount)) return paise(it.gst_amount);
  if (has(it.gst_rate) && has(it.taxable_amount)) return Math.round(it.taxable_amount * it.gst_rate);
  return null;
}

function finding(code: string, field: ComponentField, label: string, expected: number, observed: number, reason: string): ComponentFinding {
  return { code, field, label, expected: r2(expected), observed: r2(observed), difference: r2(observed - expected), reason };
}

export function reconcileTaxComponents(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): ComponentReconciliation {
  const tol = tolerancePaise + Math.min(items.length, 200); // each line's tax is rounded to the paisa
  const H = taxHeadsPaise(e);
  const fromComponents = H.cgst + H.sgst + H.utgst + H.igst;
  const memo = e.document_type === "credit_note" || e.document_type === "debit_note";
  const foreign = isForeign(e.currency, e.exchange_rate) && hasRate(e.exchange_rate);
  // Freight / packaging printed as pre-tax charges (not as item rows) carry tax in the invoice heads that the item lines do not show,
  // so the heads cannot be rebuilt from the lines alone when the lines are not labelled.
  const hasExtraCharges = nz(e.pre_tax_charges);
  let taxes = items.map(lineTax);
  const linesKnown = items.length > 0 && taxes.every((t) => t !== null);
  // Line taxes that already contain the cess (GST + cess) are not CGST + SGST. Same rule as validateTaxAllocation (tax-components.ts).
  const noCess = linesKnown ? removeCessFromLineTaxes(e, items, taxes, tol) : null;
  if (noCess) taxes = noCess.taxes;
  const sumTaxes = linesKnown ? items.reduce((a, it, i) => a + (it.applied_tax_type === "NONE" ? 0 : (taxes[i] as number)), 0) : null;
  const out: ComponentReconciliation = {
    basis: "none", heads: [], cess: null, totalGst: null, lineSplit: null,
    totals: { fromComponents: r2(fromComponents), fromLines: sumTaxes === null ? null : r2(sumTaxes) },
    lineTaxIncludesCess: noCess ? r2(noCess.cess) : null,
  };
  if (!linesKnown) return out;
  const off = (a: number, b: number) => Math.abs(a - b) > tol;

  // ---- Split the lines by head --------------------------------------------------------------------------------------
  let split: LineTaxSplit | null = null;
  const labelled = items.every((it) => LABELLED.has(String(it.applied_tax_type)));
  if (labelled) {
    split = splitLineTaxes(items, taxes);
    out.basis = "labelled_lines";
  } else if (!foreign && !memo && !hasExtraCharges) {
    // Lines say nothing about their tax: only an invoice that is NOT mixed can still be split (IGST only, or CGST + state tax).
    const mixed = nz(e.igst_amount) && (nz(e.cgst_amount) || hasStateTax(e));
    const total = sumTaxes as number;
    if (!mixed && nz(e.igst_amount)) split = { igst: total, cgst: 0, sgst: 0, utgst: 0, unlabelled: 0 };
    else if (!mixed && (nz(e.cgst_amount) || hasStateTax(e))) split = { igst: 0, cgst: total / 2, sgst: total / 2, utgst: 0, unlabelled: 0 };
    if (split) out.basis = "supply_type";
  }

  if (split) {
    out.lineSplit = { igst: r2(split.igst), cgst: r2(split.cgst), sgst: r2(split.sgst), utgst: r2(split.utgst) };
    const n = (t: string) => items.filter((it) => it.applied_tax_type === t).length;
    const nIgst = n("IGST"), nSgst = n("CGST_SGST"), nUt = n("CGST_UTGST");
    const sL = split.sgst, uL = split.utgst;
    const utKnown = known(e.utgst_amount) && out.basis === "labelled_lines"; // legacy rows keep the whole state tax in SGST

    // IGST
    if (off(H.igst, split.igst)) {
      const reason = split.igst === 0 ? "No line is charged IGST, but the invoice shows IGST."
        : H.igst === 0 ? `The ${out.basis === "labelled_lines" ? `${nIgst} IGST line(s)` : "item lines"} add up to ${inr(r2(split.igst))} of IGST, but no IGST was found at invoice level.`
        : `The ${out.basis === "labelled_lines" ? `${nIgst} IGST line(s)` : "item lines"} add up to ${inr(r2(split.igst))} of IGST.`;
      const f0 = finding("igst_mismatch", "igst", "IGST", split.igst, H.igst, reason);
      if (out.basis === "labelled_lines") {
        f0.lines = items.map((it, i) => ({ it, i })).filter(({ it }) => it.applied_tax_type === "IGST")
          .map(({ it, i }) => ({ position: i + 1, taxable: has(it.taxable_amount) ? it.taxable_amount : null, rate: has(it.gst_rate) ? it.gst_rate : null, tax: r2(taxes[i] as number) }));
      }
      out.heads.push(f0);
    }

    // CGST: the aggregate over both the intra-state and the Union Territory lines
    if (off(H.cgst, split.cgst)) {
      const scope = out.basis === "labelled_lines"
        ? `CGST is charged on every CGST+SGST line (${nSgst}) and every CGST+UTGST line (${nUt}), so the invoice CGST is the total of both`
        : "CGST is half of the GST on all item lines";
      out.heads.push(finding("cgst_mismatch", "cgst", "CGST", split.cgst, H.cgst, `${scope}: ${inr(r2(split.cgst))} from the lines.`));
    }

    // State-level tax: SGST and UTGST are two separate heads
    if (out.basis === "labelled_lines" && utKnown) {
      if (uL > tol && H.utgst === 0 && off(H.utgst, uL)) {
        if (!off(H.sgst, sL + uL)) {
          const why = `The SGST amount (${inr(r2(H.sgst))}) equals the SGST lines (${inr(r2(sL))}) plus the UTGST lines (${inr(r2(uL))}). UTGST is a separate head and must not be merged into SGST.`;
          if (off(H.sgst, sL)) out.heads.push(finding("utgst_merged_into_sgst", "sgst", "SGST", sL, H.sgst, why));
          out.heads.push(finding("utgst_merged_into_sgst", "utgst_amount", "UTGST", uL, H.utgst, why));
        } else {
          out.heads.push(finding("utgst_missing", "utgst_amount", "UTGST", uL, H.utgst, `${nUt} line(s) are Union Territory supply (CGST + UTGST) with UTGST of ${inr(r2(uL))}, but no UTGST amount was found on the invoice.`));
          if (off(H.sgst, sL)) out.heads.push(finding("sgst_mismatch", "sgst", "SGST", sL, H.sgst, `The ${nSgst} CGST+SGST line(s) carry ${inr(r2(sL))} of SGST.`));
        }
      } else {
        if (off(H.sgst, sL)) out.heads.push(finding("sgst_mismatch", "sgst", "SGST", sL, H.sgst, `Only the ${nSgst} CGST+SGST line(s) carry SGST: ${inr(r2(sL))}. UTGST is checked on its own.`));
        if (off(H.utgst, uL)) {
          const reason = uL <= tol ? "No line is a Union Territory supply (CGST + UTGST), so no UTGST is expected."
            : `Only the ${nUt} CGST+UTGST line(s) carry UTGST: ${inr(r2(uL))}.`;
          out.heads.push(finding(uL <= tol ? "utgst_without_utgst_lines" : "utgst_mismatch", "utgst_amount", "UTGST", uL, H.utgst, reason));
        }
      }
    } else if (off(H.sgst + H.utgst, sL + uL)) {
      // UTGST not stored on its own (older row or reading), or lines not labelled: the state-level tax is compared as one figure.
      if (out.basis === "labelled_lines" && uL > tol && !off(H.sgst, sL) && H.utgst === 0) {
        out.heads.push(finding("utgst_missing", "utgst_amount", "UTGST", uL, 0, `${nUt} line(s) are Union Territory supply (CGST + UTGST) with UTGST of ${inr(r2(uL))}, but no UTGST amount was found. The SGST field holds only the SGST lines (${inr(r2(sL))}).`));
      } else {
        const cgstMatches = !off(H.cgst, split.cgst);
        const hint = cgstMatches && H.sgst + H.utgst < sL + uL ? " CGST agrees with the lines, so a separate UTGST figure may be printed on the invoice and was not read." : "";
        out.heads.push(finding("state_tax_mismatch", "sgst", hasStateTax(e) && nz(e.utgst_amount) ? "SGST + UTGST" : "SGST / UTGST", sL + uL, H.sgst + H.utgst, `The state-level tax (SGST + UTGST) must equal the CGST share of the lines: ${inr(r2(sL + uL))}.${hint}`));
      }
    }
  }

  // ---- Cess: only when the line totals (taxable + GST + cess) show it ---------------------------------------------------
  if (!foreign && items.every((it) => has(it.line_total) && has(it.taxable_amount))) {
    const implied = items.reduce((a, it, i) => a + paise(it.line_total) - paise(it.taxable_amount) - (taxes[i] as number), 0);
    if (implied > tol && off(H.cess, implied)) {
      out.cess = finding("cess_mismatch", "cess", "Cess", implied, H.cess,
        H.cess === 0 ? `The item totals (taxable value + GST + cess) carry ${inr(r2(implied))} more than taxable value + GST, but no cess was found at invoice level.`
          : `The item totals (taxable value + GST + cess) imply ${inr(r2(implied))} of cess.`);
    }
  }

  // ---- Total GST against the distinct components ---------------------------------------------------------------------------
  if (!foreign && !hasExtraCharges && anyGstHeadKnown(e) && out.heads.length === 0 && off(fromComponents, sumTaxes as number)) {
    out.totalGst = finding("total_gst_mismatch", "total_gst", "Total GST", sumTaxes as number, fromComponents,
      `CGST + SGST + UTGST + IGST (${inr(r2(fromComponents))}) does not match the GST of the item lines (${inr(r2(sumTaxes as number))}).`);
  }
  return out;
}

// One review flag that lists every finding with its field, expected value, observed value and reason.
export function componentFlag(code: string, findings: ComponentFinding[], extra: Record<string, unknown> = {}): ReviewFlag {
  const parts = findings.map((f) => `${f.label}: expected ${inr(f.expected)}, found ${inr(f.observed)}. ${f.reason}`);
  return {
    code, severity: "warning", field: findings[0].field,
    message: `${parts.join(" ")} Check the original.`,
    details: {
      ...extra,
      components: findings.map((f) => ({ field: f.field, label: f.label, expected: f.expected, observed: f.observed, difference: f.difference, reason: f.reason, diagnosis: f.code, ...(f.lines ? { lines: f.lines } : {}) })),
    },
  };
}
