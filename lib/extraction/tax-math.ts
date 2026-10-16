// Tax-head math, second layer. Independent of the main total check in gst-engine.ts: it looks at each tax head
// (CGST, SGST / UTGST, IGST, Cess, TCS, TDS) on its own and explains WHY a total does not add up.
// Nothing here changes an extracted value. It only returns flags, a regime note and diagnosis hints.
//
//   check 1  CGST and SGST / UTGST are always charged at the same amount on one invoice
//   check 2  only one of CGST / SGST printed (the other one was probably missed)
//   check 3  tax printed on a line vs taxable x rate of that line (line by line; ONE flag per line: item_tax_rate_mismatch)
//   check 4  Cess, TCS and TDS must be believable amounts (a misread digit is the usual cause)
//   check 5  diagnoseTotalMismatch(): which single head, if left out / counted twice, explains a wrong total
//
// UTGST: Union Territories without a legislature charge UTGST instead of SGST. It has its own field (utgst_amount) and is
// never merged into sgst_amount. The state-level side of an invoice is SGST + UTGST (tax-components.ts); CGST equals that
// SUM, not SGST alone, so an invoice with SGST lines and UTGST lines is not flagged. Older rows that kept a UT supply in
// sgst_amount have utgst_amount = null and still work (the sum is the same).
import { isForeign, hasRate } from "./arithmetic.ts";
import { toPaise } from "./normalize.ts";
import { isIntraStateSupply, isSezSupply, NO_STATE_CODES, rawStateCode, UTGST_STATE_CODES } from "../gst/states.ts";
import { hasStateTax, removeCessFromLineTaxes, stateTaxLabel } from "./tax-components.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

// The UTGST set (04, 25, 26, 31, 35, 38) and the state table are shared: lib/gst/states.ts.
export { UTGST_STATE_CODES };

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const nonZero = (v: number | null | undefined): boolean => has(v) && v !== 0;
const p = (v: number | null | undefined): number => (has(v) ? toPaise(v) : 0);

const stateOf = rawStateCode;

export type TaxRegimeKind = "intra_state" | "inter_state" | "not_determined";
export interface TaxRegime {
  kind: TaxRegimeKind;
  supplierState: string | null;
  placeOfSupplyState: string | null;
  expectedHeads: "CGST+SGST" | "CGST+UTGST" | "IGST" | null;
  stateTaxHead: "SGST" | "UTGST" | null; // which state-level head an intra-state supply from this supplier carries
}

// Which tax heads a supply is expected to carry, from the supplier GSTIN state and the place of supply.
export function taxRegimeOf(e: Pick<StoredExtracted, "vendor_gstin" | "place_of_supply"> & { buyer_name?: string | null }): TaxRegime {
  const sup = stateOf(e.vendor_gstin, "gstin");
  const pos = stateOf(e.place_of_supply, "place");
  const head: TaxRegime["stateTaxHead"] = sup === null ? null : UTGST_STATE_CODES.has(sup) ? "UTGST" : "SGST";
  if (!sup || !pos || NO_STATE_CODES.has(pos)) return { kind: "not_determined", supplierState: sup, placeOfSupplyState: pos, expectedHeads: null, stateTaxHead: head };
  // SEZ supplies are inter-state even inside one state; codes 25 and 26 are one UT (lib/gst/states.ts).
  if (isIntraStateSupply(sup, pos, isSezSupply(e)) === true) return { kind: "intra_state", supplierState: sup, placeOfSupplyState: pos, expectedHeads: head === "UTGST" ? "CGST+UTGST" : "CGST+SGST", stateTaxHead: head };
  return { kind: "inter_state", supplierState: sup, placeOfSupplyState: pos, expectedHeads: "IGST", stateTaxHead: head };
}

export interface TaxHeadCheck {
  flags: ReviewFlag[];
  regime: TaxRegime;
}

const MAX_POSITIONS = 50;
const IMPLAUSIBLE_PERCENT = 20; // TCS / TDS above 20 % of the taxable value is never a real withholding rate
const CESS_MAX_TIMES_TAXABLE = 5; // the highest real cess rates are around 200 % (tobacco); 5x is a safe misread detector

export function checkTaxHeads(e: StoredExtracted, items: StoredItem[], tolerancePaise: number): TaxHeadCheck {
  const flags: ReviewFlag[] = [];
  const regime = taxRegimeOf(e);
  const memo = e.document_type === "credit_note" || e.document_type === "debit_note";
  const tol = tolerancePaise + Math.min(items.length, 200); // each line's tax is rounded to the paisa
  const stateHead = regime.stateTaxHead ?? "SGST";
  const stateLabel = hasStateTax(e) && nonZero(e.utgst_amount) ? stateTaxLabel(e) : regime.kind === "intra_state" ? (regime.stateTaxHead === "UTGST" ? "UTGST" : "SGST") : "SGST / UTGST";

  // 1. CGST and SGST / UTGST are always equal on one invoice (each is half of the GST rate).
  // State-level side = SGST + UTGST (each counted once). Equal to CGST on every intra-state line, so equal in total too.
  const cg = p(e.cgst_amount), sg = p(e.sgst_amount) + p(e.utgst_amount);
  // CGST agrees with the state-level tax once a UTGST of exactly the gap is added: a Union Territory figure was probably not read.
  const missingUtgstHint = !has(e.utgst_amount) && cg > sg && Math.abs((cg - sg) - sg) <= tol ? ", or a separate UTGST (Union Territory GST) figure is printed and was not read" : "";
  if (has(e.cgst_amount) && (has(e.sgst_amount) || has(e.utgst_amount)) && (cg !== 0 || sg !== 0) && !memo && Math.abs(Math.abs(cg) - Math.abs(sg)) > tol) {
    flags.push({
      code: "cgst_sgst_unequal", severity: "warning", field: "sgst",
      message: `${stateLabel}: expected INR ${(cg / 100).toFixed(2)} (equal to CGST), found INR ${(sg / 100).toFixed(2)}. CGST and ${stateLabel} are charged at the same amount, so one of them was probably misread${missingUtgstHint}. Check the original.`,
      details: {
        cgst: cg / 100, sgst: p(e.sgst_amount) / 100, utgst: p(e.utgst_amount) / 100, stateTax: sg / 100, difference: Math.abs(Math.abs(cg) - Math.abs(sg)) / 100, stateTaxHead: stateHead,
        field: "sgst", expected: cg / 100, observed: sg / 100,
        reason: `CGST (INR ${(cg / 100).toFixed(2)}) must equal the state-level tax (SGST + UTGST, INR ${(sg / 100).toFixed(2)}).${missingUtgstHint}`,
      },
    });
  }

  // 2. Only one of the two printed, no IGST on the invoice: the other one was most likely missed.
  if (!memo && !nonZero(e.igst_amount) && (nonZero(e.cgst_amount) !== hasStateTax(e)) && (has(e.cgst_amount) || has(e.sgst_amount) || has(e.utgst_amount))) {
    const present = nonZero(e.cgst_amount) ? "CGST" : stateLabel;
    const absent = nonZero(e.cgst_amount) ? stateLabel : "CGST";
    flags.push({
      code: "cgst_sgst_one_sided", severity: "warning", field: nonZero(e.cgst_amount) ? "sgst" : "cgst",
      message: `${present} was read but ${absent} was not (or is 0). Without IGST both are normally charged. Check the original.`,
      details: { cgst: cg / 100, sgst: p(e.sgst_amount) / 100, utgst: p(e.utgst_amount) / 100 },
    });
  }

  // 3. Tax printed on a line vs taxable x rate of that line. A line tax of about half the expected figure usually means only
  // one of CGST / SGST was printed in that column, so it is accepted; anything else is a misread digit or a wrong rate.
  const foreign = isForeign(e.currency, e.exchange_rate) && hasRate(e.exchange_rate);
  // "One head only" (a line tax of half the expected figure) is only believable when the invoice is split into CGST + SGST / UTGST.
  // On an inter-state (IGST) supply there is ONE head carrying the full rate, so 9 % instead of 18 % is a wrong rate, not a column
  // that shows half. When the regime cannot be determined, half is accepted only if the invoice itself shows CGST / state tax and no IGST.
  const allowHalf = regime.kind === "intra_state" || (regime.kind === "not_determined" && !nonZero(e.igst_amount) && (nonZero(e.cgst_amount) || hasStateTax(e)));
  if (!foreign) {
    const bad: { position: number; expected: number; extracted: number }[] = [];
    // Line tax that already contains the cess (GST + cess): compare the GST part with taxable x rate (see tax-components.ts).
    const noCess = removeCessFromLineTaxes(e, items, items.map((it) => (has(it.gst_amount) ? toPaise(it.gst_amount) : null)), tol);
    items.forEach((it, i) => {
      if (it.applied_tax_type === "NONE" || !has(it.gst_amount) || !has(it.gst_rate) || !has(it.taxable_amount)) return;
      const expected = toPaise((it.taxable_amount * it.gst_rate) / 100);
      const got = toPaise(it.gst_amount);
      const allowed = Math.max(tolerancePaise, Math.round(Math.abs(expected) * 0.005));
      if (Math.abs(got - expected) <= allowed) return;
      if (allowHalf && Math.abs(got - expected / 2) <= allowed) return; // one head only (CGST + SGST / UTGST invoices only)
      const gstPart = noCess ? noCess.taxes[i] : null;
      if (gstPart !== null && Math.abs(gstPart - expected) <= allowed) return; // rate is the GST rate, the printed tax also holds the cess
      bad.push({ position: i + 1, expected: expected / 100, extracted: got / 100 });
    });
    // One flag per line, with itemPosition, so the review screen shows it next to that line. This is the ONLY line-tax verdict:
    // review/gst.ts no longer raises its own (stricter) item_tax_rate_mismatch, so one line can never get two different answers.
    for (const b of bad.slice(0, MAX_POSITIONS)) {
      const it = items[b.position - 1];
      flags.push({
        code: "item_tax_rate_mismatch", severity: "warning", field: "tax_amount", itemPosition: b.position,
        message: "The item's GST amount does not match its taxable value at the stated rate. The rate or the tax amount may have been misread. Check the original.",
        details: { expected: b.expected, extracted: b.extracted, rate: it.gst_rate },
      });
    }
  }

  // 4. Cess, TCS and TDS: believable amounts.
  const base = has(e.taxable_amount) ? Math.abs(toPaise(e.taxable_amount)) : null;
  if (base !== null && base > 0) {
    if (has(e.cess_amount) && Math.abs(p(e.cess_amount)) > base * CESS_MAX_TIMES_TAXABLE) {
      flags.push({
        code: "cess_implausible", severity: "warning", field: "cess",
        message: "The cess is far larger than the taxable value. A digit may have been misread, or another figure was copied into the cess field. Check the original.",
        details: { cess: p(e.cess_amount) / 100, taxable: base / 100 },
      });
    }
    for (const [key, code, label] of [["tcs_amount", "tcs_implausible", "TCS"], ["tds_amount", "tds_implausible", "TDS"]] as const) {
      const v = e[key];
      if (has(v) && Math.abs(toPaise(v)) * 100 > base * IMPLAUSIBLE_PERCENT) {
        flags.push({
          code, severity: "warning", field: key,
          message: `The ${label} is more than ${IMPLAUSIBLE_PERCENT}% of the taxable value, which is not a real ${label} rate. A digit may have been misread. Check the original.`,
          details: { amount: Math.abs(toPaise(v)) / 100, taxable: base / 100 },
        });
      }
    }
  }
  if (has(e.tds_amount) && has(e.total_amount) && !memo && Math.abs(p(e.tds_amount)) > 0 && Math.abs(p(e.tds_amount)) >= Math.abs(toPaise(e.total_amount)) && !flags.some((f) => f.code === "tds_implausible")) {
    flags.push({ code: "tds_implausible", severity: "warning", field: "tds_amount", message: "The TDS is as large as the grand total, which cannot be. Check the original.", details: { tds: Math.abs(p(e.tds_amount)) / 100, grandTotal: toPaise(e.total_amount) / 100 } });
  }

  return { flags, regime };
}

// ---- Diagnosis of a total that does not add up -----------------------------------------------------------------------------

export interface TotalParts {
  actual: number; // printed grand total, paise
  base: number; // taxable base used by the total check, paise
  cgst: number; sgst: number; utgst?: number; igst: number; cess: number; tcs: number; tds: number; // paise, magnitudes
  discount: number | null;
  charges: number | null;
  expectedTotal: number; // base + cgst + sgst + utgst + igst + cess + tcs, paise
  lineImpliedTax: number | null; // sum of taxable x rate over the lines, paise
}

export interface Diagnosis {
  code: string;
  message: string;
  // Other codes that explain the printed total by exactly the same amount (for example CGST = SGST, so "no SGST" and "no CGST"
  // cannot be told apart from the amounts alone). Present only when the explanation is NOT unique.
  ambiguousWith?: string[];
}

// Which single explanation reproduces the printed total? Only explanations within INR 2.00 are returned, best first.
// Explanations that move the total by the same amount are one finding, not several competing "most likely" ones: they are returned
// together and each carries the codes of the others in `ambiguousWith`.
export function diagnoseTotalMismatch(t: TotalParts, tolerancePaise = 200): Diagnosis[] {
  const diff = t.actual - t.expectedTotal;
  const tries: { delta: number; code: string; message: string }[] = [];
  const add = (delta: number, code: string, message: string) => { if (delta !== 0) tries.push({ delta, code, message }); };
  const ut = t.utgst ?? 0; // utgst is optional (most invoices have none); a missing figure is 0
  add(-t.tds, "total_is_after_tds", "The printed total looks like the amount AFTER TDS. The grand total is before TDS, the net payable is after it.");
  add(-t.tcs, "total_without_tcs", "The printed total does not seem to include TCS, or the TCS amount was misread.");
  add(-t.cess, "total_without_cess", "The printed total does not seem to include the cess, or the cess amount was misread.");
  add(-t.sgst, "total_without_sgst", "The printed total looks like it has no SGST / UTGST in it. The SGST / UTGST amount may have been misread.");
  add(-ut, "total_without_utgst", "The printed total looks like it has no UTGST in it. The UTGST amount may be missing or was merged into the SGST field.");
  add(ut, "utgst_counted_twice", "The UTGST seems to be counted twice, or the UTGST figure was also copied into the SGST field.");
  // Without a UTGST figure, "neither SGST nor UTGST" is the same finding as "no SGST": it is only a separate explanation when UTGST exists.
  if (ut !== 0) add(-(t.sgst + ut), "total_without_state_tax", "The printed total looks like it has neither SGST nor UTGST in it.");
  add(-t.cgst, "total_without_cgst", "The printed total looks like it has no CGST in it. The CGST amount may have been misread.");
  add(-t.igst, "total_without_igst", "The printed total looks like it has no IGST in it. The IGST amount may have been misread.");
  add(t.sgst, "sgst_counted_twice", "The SGST / UTGST seems to be counted twice, or the SGST figure was copied into another field.");
  add(t.cgst, "cgst_counted_twice", "The CGST seems to be counted twice, or the CGST figure was copied into another field.");
  // Printed total higher than the read heads by exactly the state tax: a separate UTGST line was probably printed but not read.
  // (utgst is optional, so "not read" means no UTGST figure at all, null or 0.)
  if (ut === 0) add(t.sgst, "utgst_not_read", "The printed total is higher by exactly the SGST amount. A separate UTGST (Union Territory GST) figure may be printed on the invoice but was not read.");
  add(t.cess, "cess_counted_twice", "The cess seems to be counted twice, or it was also copied into another field.");
  if (t.cgst !== 0 && t.sgst !== 0) add(-(t.cgst + t.sgst), "total_without_cgst_sgst", "The printed total looks like it has neither CGST nor SGST / UTGST in it.");
  if (t.tds !== 0 && t.tcs !== 0) add(-(t.tcs + t.tds), "total_without_tcs_after_tds", "The printed total looks like it is after TDS and without TCS.");
  if (t.discount !== null) add(-t.discount, "discount_deducted_twice", "The discount seems to be deducted a second time in the printed total.");
  if (t.charges !== null) add(t.charges, "pre_tax_charges_missing", "The printed total seems to include freight / packing charges that are not in the taxable value.");
  // Sorted by how close each explanation lands, so the best one comes first (equal gaps keep the order above).
  const near = tries
    .map((x) => ({ ...x, gap: Math.abs(diff - x.delta) }))
    .filter((x) => x.gap <= tolerancePaise)
    .sort((a, b) => a.gap - b.gap);
  const groups: typeof near[] = [];
  for (const x of near) {
    const g = groups.find((grp) => grp[0].delta === x.delta);
    if (g) g.push(x); else groups.push([x]);
  }
  return groups.slice(0, 3).flatMap((g) => g.map((x): Diagnosis => ({
    code: x.code, message: x.message,
    ...(g.length > 1 ? { ambiguousWith: g.filter((y) => y !== x).map((y) => y.code) } : {}),
  })));
}
