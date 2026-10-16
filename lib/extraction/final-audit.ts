// Final verification gate: runs AFTER extraction, over the WHOLE content of the document, in three separate layers.
// It only ADDS information (a report in validation_summary.verification and review flags). It never changes a value.
//
//   Layer 1  RULES      Every saved value is checked against what the rules of an Indian GST invoice allow:
//                       GSTIN layout + check digit + state code + PAN, supplier is not buyer, date range, place of supply
//                       (printed code and state name agree), currency code, e-invoice identifiers, and that the invoice
//                       arithmetic ties (the flags of the GST engine are counted, not repeated).
//   Layer 2  CONSENSUS  Every header value is compared with EVERY full reading (first, second, audit). A value must be supported by a
//                       strict majority of the readings that had a value; the item table is checked cell by cell the same way.
//   Layer 3  EVIDENCE   Facts that do not come from the same reading as the value: the blind parties reading(s) (printed PAN,
//                       printed state, list of printed GSTINs with roles, names), the amount in words and the blind key-figures
//                       reading for the grand total.
//
// A field is "verified" only when it passed every layer that had something to say about it. Fields that did not are listed
// in the report and in ONE review flag, so a person looks at exactly those.
import { cleanIdentifier } from "./identifiers.ts";
import { checkGstin } from "./normalize.ts";
import { sameStateCode } from "../gst/states.ts";
import { gstinIsValid, gstinPan, isPanLayout, namesCompatible, normGstin, STATE_CODES, stateCodeFromText } from "./party-check.ts";
import type { GstinVerdict } from "./party-check.ts";
import { sameField } from "./verify.ts";
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS, ITEM_NUMBER_FIELDS, ITEM_TEXT_FIELDS } from "./types.ts";
import type { ModelField, ModelOutput, PartiesReading, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export type LayerNo = 1 | 2 | 3;

export interface LayerFinding {
  field: string;
  itemPosition?: number;
  reason: string;
}

export interface AuditLayer {
  layer: LayerNo;
  name: "rules" | "consensus" | "evidence";
  ran: boolean; // false when the layer had nothing to work with (for example only one reading exists)
  checked: number; // number of values examined
  failed: LayerFinding[];
}

export type FieldVerdict = "verified" | "needs_review" | "not_present";

export interface FieldVerification {
  status: FieldVerdict;
  failed_layers: LayerNo[];
  reasons: string[];
}

export interface AuditReport {
  passed: boolean; // no value failed any layer
  complete: boolean; // all three layers could run
  readings: number; // full readings that took part
  parties_readings: number;
  layers: AuditLayer[];
  fields: Record<string, FieldVerification>;
}

export interface AuditInput {
  extracted: StoredExtracted;
  items: StoredItem[];
  merged: ModelOutput; // the voted reading the saved values were normalized from
  readings: ModelOutput[]; // every full reading (first, second, audit)
  parties: PartiesReading[];
  verdicts: { supplier_gstin: GstinVerdict; buyer_gstin: GstinVerdict } | null;
  totalStatus: string | null; // validation_summary.total_consensus.status
  flags: ReviewFlag[]; // flags raised so far (checks, GST engine, recheck notes)
  now?: Date;
}

const GST_START = "2017-07-01";
const FIELD_LABEL: Record<string, string> = {
  supplier_name: "supplier name", supplier_gstin: "supplier GSTIN", buyer_name: "buyer name", buyer_gstin: "buyer GSTIN",
  invoice_number: "invoice number", invoice_date: "invoice date", place_of_supply: "place of supply", currency: "currency",
  taxable_value: "taxable value", discount_total: "discount total", cgst: "CGST", sgst: "SGST", utgst_amount: "UTGST", igst: "IGST", cess: "cess", grand_total: "grand total",
  irn: "IRN", ack_no: "acknowledgement number", eway_bill_no: "e-way bill number", line_items: "item table",
};
const label = (k: string) => FIELD_LABEL[k] ?? k.replace(/_/g, " ");

function present(f: ModelField<string | number> | undefined): boolean {
  return !!f && f.status === "present" && f.value !== null;
}

// Header text fields of the saved record by model key.
function savedText(e: StoredExtracted, key: string): string | null {
  switch (key) {
    case "supplier_name": return e.vendor_name;
    case "supplier_gstin": return e.vendor_gstin;
    case "buyer_name": return e.buyer_name;
    case "buyer_gstin": return e.buyer_gstin;
    case "invoice_number": return e.invoice_number;
    case "invoice_date": return e.invoice_date;
    case "place_of_supply": return e.place_of_supply;
    case "currency": return e.currency;
    case "irn": return e.irn ?? null;
    case "ack_no": return e.ack_no ?? null;
    case "eway_bill_no": return e.eway_bill_no ?? null;
    default: return null;
  }
}

// ---- Layer 1: rules ---------------------------------------------------------------------------------------------------

function layerRules(inp: AuditInput): AuditLayer {
  const { extracted: e, items, flags } = inp;
  const failed: LayerFinding[] = [];
  let checked = 0;
  const fail = (field: string, reason: string, itemPosition?: number) => failed.push({ field, reason, ...(itemPosition ? { itemPosition } : {}) });

  // GSTINs
  const gst: Record<"supplier_gstin" | "buyer_gstin", string | null> = {
    supplier_gstin: e.vendor_gstin ? normGstin(e.vendor_gstin) : null,
    buyer_gstin: e.buyer_gstin ? normGstin(e.buyer_gstin) : null,
  };
  for (const key of ["supplier_gstin", "buyer_gstin"] as const) {
    const g = gst[key];
    if (!g) continue;
    checked += 1;
    const c = checkGstin(g);
    if (!c.ok) fail(key, c.reason === "format" ? "Not a valid GSTIN layout." : "The GSTIN check digit does not match.");
    else if (!STATE_CODES[g.slice(0, 2)]) fail(key, `State code ${g.slice(0, 2)} is not a GST state code.`);
    else {
      const pan = gstinPan(g);
      if (!pan || !isPanLayout(pan)) fail(key, "The PAN inside the GSTIN is not a valid PAN layout.");
    }
  }
  if (gst.supplier_gstin && gst.buyer_gstin) {
    checked += 1;
    if (gst.supplier_gstin === gst.buyer_gstin) fail("buyer_gstin", "The buyer GSTIN is the same as the supplier GSTIN.");
  }

  // Invoice date
  if (e.invoice_date) {
    checked += 1;
    const tomorrow = new Date((inp.now ?? new Date()).getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (e.invoice_date < GST_START) fail("invoice_date", "The date is before GST started (1 July 2017).");
    else if (e.invoice_date > tomorrow) fail("invoice_date", "The date is in the future.");
  }

  // Place of supply: when both a state code and a state name are printed they must name the same state.
  if (e.place_of_supply) {
    checked += 1;
    const code = /\((\d{2})\)/.exec(e.place_of_supply)?.[1] ?? /^\s*(\d{2})\b/.exec(e.place_of_supply)?.[1] ?? null;
    const byName = stateCodeFromText(e.place_of_supply.replace(/\(\s*\d{2}\s*\)|^\s*\d{2}\b/g, ""));
    if (code && !STATE_CODES[code]) fail("place_of_supply", `State code ${code} is not a GST state code.`);
    else if (code && byName && !sameStateCode(code, byName)) fail("place_of_supply", `The printed state code ${code} and the state name (${STATE_CODES[byName]}) do not match.`);
  }

  // Currency
  if (e.currency) {
    checked += 1;
    if (!/^[A-Z]{3}$/.test(e.currency)) fail("currency", "The currency is not a 3-letter code.");
  }

  // Invoice number: GST rule 46 allows at most 16 characters (letters, digits, "/" and "-"). Real invoices break it, so this is a
  // finding only when the number is clearly not an invoice number (empty after trimming, or only punctuation).
  if (e.invoice_number !== null) {
    checked += 1;
    if (!/[A-Za-z0-9]/.test(e.invoice_number)) fail("invoice_number", "The invoice number has no letters or digits.");
  }

  // e-invoice identifiers
  for (const key of ["irn", "ack_no", "eway_bill_no"] as const) {
    const v = savedText(e, key);
    if (!v) continue;
    checked += 1;
    if (!cleanIdentifier(key, v).valid) fail(key, key === "irn" ? "The IRN is not 64 hexadecimal characters." : key === "ack_no" ? "The acknowledgement number is not 9 to 15 digits." : "The e-way bill number is not 12 digits.");
  }

  // Items: HSN/SAC that did not survive normalization.
  items.forEach((it, i) => {
    if (it.field_status.hsn_sac?.state === "invalid") fail("hsn_sac", "The HSN/SAC is not 4 to 8 digits.", i + 1);
  });

  // Arithmetic: the GST engine already tested it. Count its verdict instead of repeating the sums.
  const arithmetic = flags.filter((f) => f.code.startsWith("arithmetic_") && (f.severity === "error" || f.severity === "warning"));
  checked += 1;
  if (arithmetic.length > 0) {
    const field = arithmetic.some((f) => f.code === "arithmetic_total_mismatch") ? "grand_total" : arithmetic.some((f) => f.code === "arithmetic_subtotal_mismatch") ? "taxable_value" : "line_items";
    fail(field, `The invoice arithmetic does not tie (${Array.from(new Set(arithmetic.map((f) => f.code))).join(", ")}).`);
  }
  return { layer: 1, name: "rules", ran: true, checked, failed };
}

// ---- Layer 2: consensus over every full reading -------------------------------------------------------------------------

function layerConsensus(inp: AuditInput): AuditLayer {
  const { merged, readings } = inp;
  const failed: LayerFinding[] = [];
  if (readings.length < 2) return { layer: 2, name: "consensus", ran: false, checked: 0, failed };
  let checked = 0;

  // Same principle as the vote in verify.ts: when the readings do not form a majority, a rule that can be PROVEN settles it.
  // The consensus layer therefore accepts a minority value only when such a proof exists (a GSTIN whose check digit and state code
  // pass while every different reading fails them, a valid date / HSN / identifier, an amount while the invoice arithmetic ties).
  const arithmeticTies = !inp.flags.some((f) => f.code.startsWith("arithmetic_") && (f.severity === "error" || f.severity === "warning"));
  const proven = (key: string, final: ModelField<string | number>, others: (ModelField<string | number> | undefined)[]): boolean => {
    const v = final.value;
    const rivals = others.filter((f) => present(f) && !sameField(key, final as never, f as never)).map((f) => f?.value);
    if (key === "supplier_gstin" || key === "buyer_gstin") return typeof v === "string" && gstinIsValid(normGstin(v)) && rivals.every((r) => typeof r !== "string" || !gstinIsValid(normGstin(r)));
    if (key === "invoice_date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && rivals.every((r) => typeof r !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r));
    if (key === "hsn_sac") return typeof v === "string" && /^\d{4,8}$/.test(v.replace(/[\s.\-]/g, "")) && rivals.every((r) => typeof r !== "string" || !/^\d{4,8}$/.test(r.replace(/[\s.\-]/g, "")));
    if (typeof v === "number" && key !== "exchange_rate") return arithmeticTies;
    return false;
  };

  // A value is supported when a strict majority of the readings that HAD a value gave the same one, or when a rule proves it.
  const support = (key: string, final: ModelField<string | number> | undefined, others: (ModelField<string | number> | undefined)[]) => {
    if (!present(final)) return null;
    const have = others.filter((f) => present(f));
    if (have.length < 2) return null; // one reading only: nothing to compare with
    const agree = have.filter((f) => sameField(key, final as never, f as never)).length;
    return { agree, of: have.length, proven: agree * 2 <= have.length ? proven(key, final as ModelField<string | number>, have) : false };
  };

  for (const key of [...HEADER_TEXT_FIELDS, ...HEADER_AMOUNT_FIELDS] as const) {
    if (key === "supplier_name" || key === "buyer_name") continue; // names: compared in layer 3 (soft: "Acme" / "Acme Pvt Ltd")
    const s = support(key, merged[key], readings.map((r) => r[key]));
    if (!s) continue;
    checked += 1;
    if (s.agree * 2 <= s.of && !s.proven) failed.push({ field: key, reason: `Only ${s.agree} of ${s.of} readings gave this value and no rule proves it.` });
  }

  // Item table: row count, then cell by cell among the readings that have the same number of rows.
  const rows = merged.line_items.length;
  const counts = readings.map((r) => r.line_items.length);
  const sameRows = readings.filter((r) => r.line_items.length === rows);
  checked += 1;
  if (sameRows.length * 2 <= readings.length) failed.push({ field: "line_items", reason: `Only ${sameRows.length} of ${readings.length} readings found ${rows} item row(s) (counts: ${counts.join(", ")}).` });
  if (sameRows.length >= 2) {
    const weak: LayerFinding[] = [];
    merged.line_items.forEach((row, idx) => {
      for (const key of [...ITEM_TEXT_FIELDS, ...ITEM_NUMBER_FIELDS] as const) {
        if (key === "description" || key === "unit") continue; // free wording
        const s = support(key, row[key], sameRows.map((r) => r.line_items[idx]?.[key]));
        if (!s) continue;
        checked += 1;
        if (s.agree * 2 <= s.of && !s.proven) weak.push({ field: key, itemPosition: idx + 1, reason: `Only ${s.agree} of ${s.of} readings gave this value and no rule proves it.` });
      }
    });
    failed.push(...weak.slice(0, 50));
  }
  return { layer: 2, name: "consensus", ran: true, checked, failed };
}

// ---- Layer 3: independent evidence ------------------------------------------------------------------------------------------

function layerEvidence(inp: AuditInput): AuditLayer {
  const { extracted: e, parties, verdicts, totalStatus } = inp;
  const failed: LayerFinding[] = [];
  let checked = 0;
  let ran = false;

  if (verdicts) {
    for (const key of ["supplier_gstin", "buyer_gstin"] as const) {
      const v = verdicts[key];
      if (v.status === "absent") continue;
      ran = true;
      checked += 1;
      // Only the check digit was repaired (normalize.ts, trusted only when the readings agree with high confidence): the saved
      // value is valid and the repair is already reported as "GSTIN Auto-Corrected" with the raw value kept.
      const repaired = e.field_status[key]?.autoCorrected;
      if (repaired && gstinIsValid(normGstin(repaired.to))) continue;
      // "probable" is a failure only when enough readings took part for the missing witnesses to mean something.
      if (v.status === "unverified" || v.status === "conflict" || (v.status === "probable" && v.readings >= 3)) {
        failed.push({ field: key, reason: v.problems.length ? v.problems.join(" ") : `Only ${v.witnesses} independent witness(es) confirm this GSTIN.` });
      }
    }
  }

  if (parties.length > 0) {
    ran = true;
    for (const [key, saved] of [["supplier_name", e.vendor_name], ["buyer_name", e.buyer_name]] as const) {
      const seen = parties.map((p) => (p[key]?.status === "present" ? p[key]?.value ?? null : null)).filter((x): x is string => !!x);
      if (!saved || seen.length === 0) continue;
      checked += 1;
      const verdicts2 = seen.map((n) => namesCompatible(saved, n));
      if (verdicts2.every((x) => x === false)) failed.push({ field: key, reason: `The parties reading read a different name: "${seen[0]}".` });
    }
    const pos = parties.map((p) => (p.place_of_supply?.status === "present" ? stateCodeFromText(p.place_of_supply.value) : null)).filter((x): x is string => !!x);
    const savedPos = stateCodeFromText(e.place_of_supply);
    if (savedPos && pos.length > 0) {
      checked += 1;
      if (pos.every((x) => x !== savedPos)) failed.push({ field: "place_of_supply", reason: `The parties reading read the place of supply as ${STATE_CODES[pos[0]]}, not ${STATE_CODES[savedPos]}.` });
    }
  }

  if (totalStatus) {
    ran = true;
    checked += 1;
    if (totalStatus === "unconfirmed") failed.push({ field: "grand_total", reason: "The grand total is not confirmed by enough independent witnesses (readings, amount in words, arithmetic)." });
  }
  return { layer: 3, name: "evidence", ran, checked, failed };
}

// ---- Gate ----------------------------------------------------------------------------------------------------------------------

export function auditExtraction(inp: AuditInput): { report: AuditReport; flags: ReviewFlag[] } {
  const layers = [layerRules(inp), layerConsensus(inp), layerEvidence(inp)];
  const fields: Record<string, FieldVerification> = {};
  const note = (field: string, layer: LayerNo, reason: string) => {
    const f = (fields[field] ??= { status: "needs_review", failed_layers: [], reasons: [] });
    if (!f.failed_layers.includes(layer)) f.failed_layers.push(layer);
    f.reasons.push(reason);
  };
  for (const l of layers) for (const x of l.failed) note(x.field, l.layer, x.itemPosition ? `Item ${x.itemPosition}: ${x.reason}` : x.reason);

  // Every present header field that failed nothing is "verified"; absent ones are "not_present".
  const e = inp.extracted;
  for (const key of ["supplier_name", "supplier_gstin", "buyer_name", "buyer_gstin", "invoice_number", "invoice_date", "place_of_supply", "currency", "irn", "ack_no", "eway_bill_no"]) {
    if (fields[key]) continue;
    fields[key] = { status: savedText(e, key) ? "verified" : "not_present", failed_layers: [], reasons: [] };
  }
  const amounts: Record<string, number | null> = { taxable_value: e.taxable_amount, discount_total: e.discount_amount, cgst: e.cgst_amount, sgst: e.sgst_amount, utgst_amount: e.utgst_amount ?? null, igst: e.igst_amount, cess: e.cess_amount, grand_total: e.total_amount };
  for (const [key, v] of Object.entries(amounts)) {
    if (!fields[key]) fields[key] = { status: v === null ? "not_present" : "verified", failed_layers: [], reasons: [] };
  }
  if (!fields.line_items) fields.line_items = { status: inp.items.length ? "verified" : "not_present", failed_layers: [], reasons: [] };

  const failedCount = layers.reduce((n, l) => n + l.failed.length, 0);
  const report: AuditReport = {
    passed: failedCount === 0,
    complete: layers.every((l) => l.ran),
    readings: inp.readings.length,
    parties_readings: inp.parties.length,
    layers,
    fields,
  };

  // ---- Flags ----
  const flags: ReviewFlag[] = [];
  const has = (code: string, field: string) => inp.flags.some((f) => f.code === code && f.field === field);
  if (inp.verdicts) {
    for (const key of ["supplier_gstin", "buyer_gstin"] as const) {
      const v = inp.verdicts[key];
      const bad = fields[key]?.status === "needs_review";
      if (!bad || v.status === "absent") continue;
      // The format / check digit problem already has its own flag (invalid_gstin / gstin_checksum_note): do not repeat it.
      if (has("invalid_gstin", key) || has("gstin_checksum_note", key)) continue;
      const code = v.status === "conflict" ? "gstin_conflict" : "gstin_unverified";
      flags.push({
        code, severity: "warning", field: key,
        message: `The ${label(key)} did not pass all verification layers. ${fields[key].reasons.join(" ")} Compare it with the original.`,
        details: { status: v.status, value: v.value, witnesses: v.witnesses, readings: v.readings, read_as: v.distinct, failed_layers: fields[key].failed_layers },
      });
    }
  }
  const others = Object.entries(fields).filter(([k, v]) => v.status === "needs_review" && k !== "supplier_gstin" && k !== "buyer_gstin");
  if (others.length > 0) {
    flags.push({
      code: "verification_failed", severity: "warning",
      message: `${others.length} value(s) did not pass all three verification layers: ${others.map(([k]) => label(k)).slice(0, 8).join(", ")}. Compare them with the original.`,
      details: { fields: others.slice(0, 30).map(([k, v]) => ({ field: k, layers: v.failed_layers, reasons: v.reasons.slice(0, 3) })) },
    });
  }
  return { report, flags };
}

// Used by the pipeline: should another blind parties reading be tried? True while a GSTIN is neither verified nor absent.
export function needsAnotherPartiesReading(verdicts: { supplier_gstin: GstinVerdict; buyer_gstin: GstinVerdict }): boolean {
  return [verdicts.supplier_gstin, verdicts.buyer_gstin].some((v) => v.status !== "verified" && v.status !== "absent" && !(v.value && !gstinIsValid(v.value) && v.status === "unverified" && v.distinct.length === 1 && v.readings >= 4));
}
