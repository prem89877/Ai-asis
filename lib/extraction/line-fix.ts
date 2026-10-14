// Line-item math reconciliation and auto-correction.
//
// Problem: the AI can misread ONE digit of a number (INR 10,000 read as 1,000). The line then fails
//     quantity x unit price (less discount) x exchange rate = taxable value
// and used to go straight to a human. This module tries the maths first.
//
// How it decides (nothing is changed unless every rule below holds):
//   1. The line must FAIL arithmetic.ts / validateLineItem() (same rules, same tolerance, same discount and rate readings).
//   2. Only quantity, unit price or taxable value may be corrected. Each one is solved from the other two.
//   3. A solved value is only a candidate when it looks like a real misread of the printed one (ocrPlausible):
//      a dropped / added digit, a shifted decimal point, one wrong digit, or two swapped digits.
//   4. Every candidate is scored. One point for each INDEPENDENT witness (not used in the equation):
//        - gst_amount  = taxable x gst_rate
//        - line_total  = taxable + gst_amount
//        - sum of all item taxable values = invoice taxable value
//      plus one point when the model's own confidence for that field is clearly the lowest of the three and below
//      `maxConfidence`.
//   5. The best candidate wins only with a score of at least 2 and strictly more than any other candidate, and only when
//      the field's confidence is below `maxConfidence` (or all three independent witnesses agree).
//   Otherwise nothing changes and the normal "arithmetic_line_mismatch" warning goes to a human, plus a short info note
//   saying why the auto-correction was not applied.
//
// The original value is never lost: it is kept in field_status[...].autoCorrected.from, in the info flag, and the raw
// model output stays in raw_extraction. Foreign currency lines are corrected only when the invoice PRINTS an exchange rate.
import { hasRate, isForeign, lineCandidates, validateLineItem } from "./arithmetic.ts";
import type { LineRateContext, Reading } from "./arithmetic.ts";
import { toPaise } from "./normalize.ts";
import type { FieldMeta, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export type FixField = "quantity" | "unit_price" | "taxable_amount";

// Keys of StoredItem.field_status for each correctable field (they are the model's names).
export const FIX_STATUS_KEY: Record<FixField, string> = { quantity: "quantity", unit_price: "unit_price", taxable_amount: "taxable_value" };
const FIX_LABEL: Record<FixField, string> = { quantity: "quantity", unit_price: "unit price", taxable_amount: "taxable value" };

export const DEFAULT_LINE_FIX_MAX_CONFIDENCE = 0.95;
const CONFIDENCE_MARGIN = 0.05; // the suspect field must be this much less certain than the other two
const MIN_SCORE = 2;
const RATE_REL_TOLERANCE = 0.0005; // printed exchange rates have 2 to 4 decimals (same value as arithmetic.ts)

export interface LineFixOptions {
  tolerancePaise: number;
  maxConfidence?: number; // fields the model read with at least this confidence are only corrected when all 3 witnesses agree
}

export type SkipReason = "no_candidate" | "ambiguous" | "weak_evidence" | "model_confident" | "foreign_without_rate" | "sign_change" | "zero_value";

export interface LineFixResult {
  items: StoredItem[]; // new array, corrected lines replaced; the input is never mutated
  flags: ReviewFlag[];
  fixed: number;
  skipped: number;
}

// ---- Is a corrected number a believable misread of the printed one? ---------------------------------------------------

// Digits of a number with sign, decimal point, leading and trailing zeros removed: 10,000 and 1,000 and 100.00 all give "1".
function significantDigits(v: number): string {
  return Math.abs(v).toFixed(4).replace(".", "").replace(/^0+/, "").replace(/0+$/, "");
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diff: number[] = [];
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true; // one wrong digit
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]; // two swapped digits
  }
  const [long, short] = la > lb ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true; // one digit dropped / added
  return false;
}

// A zero dropped or added, a shifted decimal point (same significant digits), one digit dropped / added / wrong, or two digits swapped.
export function ocrPlausible(printed: number, candidate: number): boolean {
  if (!Number.isFinite(printed) || !Number.isFinite(candidate) || printed === 0 || candidate === 0) return false;
  if (Math.sign(printed) !== Math.sign(candidate)) return false;
  const a = significantDigits(printed);
  const b = significantDigits(candidate);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return Math.max(a.length, b.length) >= 3 && withinOneEdit(a, b);
}

// ---- Solving the line ----------------------------------------------------------------------------------------------------

function clean(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
function roundTo(x: number, dp: number): number {
  const m = 10 ** dp;
  return Math.round(x * m) / m;
}

function netFor(gross: number, reading: Reading, discount: number): number {
  if (reading === "flat") return clean(gross - discount);
  if (reading === "percent") return clean(gross * (1 - discount / 100));
  return gross;
}

// Gross (quantity x price) that would give this net under the given reading of the discount; null when impossible.
function grossFor(net: number, reading: Reading, discount: number): number | null {
  if (reading === "flat") return net + discount;
  if (reading === "percent") return discount < 100 ? net / (1 - discount / 100) : null;
  return net;
}

interface Candidate {
  field: FixField;
  value: number;
  reading: Reading;
  score: number;
  independent: number;
  witnesses: string[];
  confidencePoint: boolean;
}

function confidenceOf(it: StoredItem, field: FixField): number {
  const m = it.field_status[FIX_STATUS_KEY[field]];
  return m && (m.state === "value" || m.state === "zero") ? m.confidence : 1;
}

type Outcome = { kind: "fixed"; best: Candidate; from: number; originalConfidence: number } | { kind: "skipped"; reason: SkipReason };

function solveLine(items: StoredItem[], index: number, extracted: StoredExtracted, rate: number, opts: Required<LineFixOptions>): Outcome {
  const it = items[index];
  const q = it.quantity as number;
  const p = it.unit_price as number;
  const t = it.taxable_amount as number;
  const tol = opts.tolerancePaise;
  const rel = rate !== 1 ? RATE_REL_TOLERANCE : 0;
  const disc = it.discount_amount ?? 0;
  if (q === 0 || p === 0 || t === 0) return { kind: "skipped", reason: "zero_value" };
  const gross = clean(q * p);
  if (gross !== 0 && gross < 0 !== t < 0) return { kind: "skipped", reason: "sign_change" };

  const within = (expectedPaise: number) => Math.abs(toPaise(t) - expectedPaise) <= tol + Math.round(Math.abs(expectedPaise) * rel);
  const raw: { field: FixField; value: number; reading: Reading }[] = [];
  for (const c of lineCandidates(it)) {
    // The line's own discount reading, e.g. "percent" -> net = gross x (1 - d/100).
    const d = c.reading === "no_discount" ? 0 : disc;
    // A. the printed taxable value is the misread one: expected value from quantity x price.
    raw.push({ field: "taxable_amount", value: roundTo(netFor(gross, c.reading, d) * rate, 2), reading: c.reading });
    // B / C. quantity or unit price is the misread one: solve it from the printed taxable value.
    const g = grossFor(t / rate, c.reading, d);
    if (g === null) continue;
    const solve = (field: "quantity" | "unit_price", other: number, dps: number[]) => {
      for (const dp of dps) {
        const v = roundTo(g / other, dp);
        const check = field === "quantity" ? clean(v * p) : clean(q * v);
        if (v !== 0 && within(toPaise(netFor(check, c.reading, d) * rate))) {
          raw.push({ field, value: v, reading: c.reading });
          return;
        }
      }
    };
    solve("quantity", p, [3]);
    solve("unit_price", q, [2, 4]);
  }

  // Keep only believable misreads, one candidate per (field, value).
  const seen = new Set<string>();
  const plausible = raw.filter((c) => {
    const printed = c.field === "taxable_amount" ? t : c.field === "quantity" ? q : p;
    const key = `${c.field}:${c.value}`;
    if (seen.has(key) || !Number.isFinite(c.value) || c.value === printed || !ocrPlausible(printed, c.value)) return false;
    seen.add(key);
    return true;
  });
  if (plausible.length === 0) return { kind: "skipped", reason: "no_candidate" };

  // Independent witnesses: nothing here is part of quantity x price = taxable.
  const allTaxable = items.every((x) => x.taxable_amount !== null) && extracted.taxable_amount !== null;
  const sumWith = (taxable: number) => items.reduce((s, x, i) => s + (i === index ? taxable : (x.taxable_amount as number)), 0);
  const conf = { quantity: confidenceOf(it, "quantity"), unit_price: confidenceOf(it, "unit_price"), taxable_amount: confidenceOf(it, "taxable_amount") };

  const scored: Candidate[] = plausible.map((c) => {
    const taxable = c.field === "taxable_amount" ? c.value : t; // the taxable value this candidate stands behind
    const witnesses: string[] = [];
    if (it.gst_amount !== null && it.gst_rate !== null && Math.abs(toPaise(it.gst_amount) - toPaise((taxable * it.gst_rate) / 100)) <= tol) witnesses.push("gst_amount");
    if (it.line_total !== null && Math.abs(toPaise(it.line_total) - toPaise(taxable + (it.gst_amount ?? 0))) <= tol) witnesses.push("line_total");
    if (allTaxable && Math.abs(toPaise(sumWith(taxable)) - toPaise(extracted.taxable_amount as number)) <= tol) witnesses.push("invoice_taxable_total");
    const others = (["quantity", "unit_price", "taxable_amount"] as FixField[]).filter((f) => f !== c.field);
    const confidencePoint = conf[c.field] < opts.maxConfidence && others.every((f) => conf[f] >= conf[c.field] + CONFIDENCE_MARGIN);
    return { ...c, witnesses, independent: witnesses.length, confidencePoint, score: witnesses.length + (confidencePoint ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < MIN_SCORE) return { kind: "skipped", reason: "weak_evidence" };
  if (scored.length > 1 && scored[1].score === best.score) return { kind: "skipped", reason: "ambiguous" };
  if (!(conf[best.field] < opts.maxConfidence) && best.independent < 3) return { kind: "skipped", reason: "model_confident" };
  const from = best.field === "taxable_amount" ? t : best.field === "quantity" ? q : p;
  return { kind: "fixed", best, from, originalConfidence: conf[best.field] };
}

// ---- Flags ---------------------------------------------------------------------------------------------------------------

const WITNESS_TEXT: Record<string, string> = { gst_amount: "GST amount", line_total: "line total", invoice_taxable_total: "invoice taxable total" };

// The audit note for a corrected value. Also used by lib/review/flags.ts to keep the note after a reviewer edits other fields.
export function lineFixFlag(position: number, field: FixField, from: number, to: number, extra: Record<string, unknown> = {}): ReviewFlag {
  const w = Array.isArray(extra.witnesses) ? (extra.witnesses as string[]).map((x) => WITNESS_TEXT[x] ?? x) : [];
  return {
    code: "line_item_auto_corrected",
    severity: "info",
    field: FIX_STATUS_KEY[field],
    itemPosition: position,
    message: `Quantity x unit price did not match the taxable value. The ${FIX_LABEL[field]} was corrected automatically from ${from} to ${to}${w.length ? ` (also matches the ${w.join(", ")})` : ""}. Compare with the original.`,
    details: { line_item_auto_corrected: true, field: FIX_STATUS_KEY[field], original: from, corrected: to, ...extra },
  };
}

const SKIP_TEXT: Record<SkipReason, string> = {
  no_candidate: "no single value fits the maths as a likely misread",
  ambiguous: "more than one value fits equally well",
  weak_evidence: "not enough independent evidence (GST amount, line total, invoice total)",
  model_confident: "the AI was confident about the printed value",
  foreign_without_rate: "no exchange rate is printed on the invoice",
  sign_change: "the printed sign differs from quantity x price",
  zero_value: "a quantity, price or taxable value is zero",
};

// ---- Entry point ---------------------------------------------------------------------------------------------------------

// Checks every line; corrects what can be proven, leaves the rest for the normal checks. Call it after normalizeExtraction()
// and BEFORE runChecks(), so the checks see the corrected values.
export function reconcileLineItems(input: StoredItem[], extracted: StoredExtracted, options: LineFixOptions): LineFixResult {
  const opts: Required<LineFixOptions> = { tolerancePaise: options.tolerancePaise, maxConfidence: options.maxConfidence ?? DEFAULT_LINE_FIX_MAX_CONFIDENCE };
  const items = input.map((it) => ({ ...it, field_status: { ...it.field_status } }));
  const flags: ReviewFlag[] = [];
  let fixed = 0;
  let skipped = 0;

  const foreign = isForeign(extracted.currency, extracted.exchange_rate);
  const printedRate = hasRate(extracted.exchange_rate) ? extracted.exchange_rate : null;
  const rate = foreign ? printedRate : 1;
  const rc: LineRateContext = { tolerancePaise: opts.tolerancePaise, foreign, explicitRate: foreign ? printedRate : null, impliedRate: null };

  items.forEach((it, i) => {
    const verdict = validateLineItem(it, i + 1, rc);
    if (verdict.status !== "fail") return;
    const out: Outcome = rate === null ? { kind: "skipped", reason: "foreign_without_rate" } : solveLine(items, i, extracted, rate, opts);
    if (out.kind === "skipped") {
      skipped += 1;
      flags.push({ code: "line_autofix_skipped", severity: "info", field: "taxable_value", itemPosition: i + 1, message: `Automatic correction was not applied: ${SKIP_TEXT[out.reason]}. Check this item against the original.`, details: { reason: out.reason } });
      return;
    }
    const { best, from, originalConfidence } = out;
    const status: FieldMeta = { state: "value", confidence: 1, source: "computed", autoCorrected: { from: String(from), to: String(best.value) } };
    it.field_status[FIX_STATUS_KEY[best.field]] = status;
    it[best.field] = best.value;
    fixed += 1;
    flags.push(lineFixFlag(i + 1, best.field, from, best.value, { witnesses: best.witnesses, confidence_check: best.confidencePoint, original_confidence: originalConfidence, discount_reading: best.reading, ...(rate !== 1 ? { exchange_rate: rate } : {}) }));
  });
  return { items, flags, fixed, skipped };
}
