// Second-check layer. The model reads the invoice twice; this file compares the two readings in plain code.
// Rules:
//  - Same value in both readings  => kept, and remembered as "confirmed by recheck".
//  - Different values             => a rule that can be proven decides (GSTIN check digit, valid date,
//                                    arithmetic of the invoice). If nothing can decide, the FIRST value is kept,
//                                    its confidence is lowered and a review flag shows both values.
//  - The model never gets the last word and no value is ever invented here.
import { checkGstin, cleanText, normalizeHsn, normalizeIsoDate, normalizeExtraction } from "./normalize.ts";
import { runChecks } from "./checks.ts";
import type { CheckOptions } from "./checks.ts";
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS, ITEM_NUMBER_FIELDS, ITEM_OPTIONAL_TEXT_FIELDS, ITEM_TEXT_FIELDS, OPTIONAL_AMOUNT_FIELDS, OPTIONAL_TEXT_FIELDS } from "./types.ts";
import type { ModelField, ModelItem, ModelOutput, ReviewFlag } from "./types.ts";

export type Scalar = string | number | null;

export interface Disagreement {
  field: string;
  itemPosition?: number;
  first: Scalar;
  second: Scalar;
  resolution: "kept_first" | "took_second" | "unresolved";
  reason: string;
}

export interface Reconciled {
  merged: ModelOutput;
  agreed: Set<string>; // header fields where both readings gave the same value
  disagreements: Disagreement[];
  itemCountMismatch: boolean;
}

const R_NOT_CONFIRMED = "The second reading could not confirm this value.";
const R_ONLY_SECOND = "Only the second reading found a value here.";
const UNSURE_CONFIDENCE = 0.5; // value kept although the second reading disagrees
const CONFIRM_ONLY_CONFIDENCE = 0.6; // value seen in one reading only

const GSTIN_KEYS = new Set(["supplier_gstin", "buyer_gstin"]);
// Free-text item fields: wording differences between two readings are normal and not worth a review flag.
// discount_type / applied_tax_type are labels the model adds, not printed values: a difference is settled quietly too.
const SOFT_ITEM_FIELDS = new Set(["description", "unit", "discount_type", "applied_tax_type"]);

type AnyField = ModelField<string> | ModelField<number>;

function gstinForm(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

function present(f: AnyField): boolean {
  return f.status === "present" && f.value !== null;
}

function scalar(f: AnyField): Scalar {
  return present(f) ? (f.value as Scalar) : null;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sameText(key: string, a: string, b: string): boolean {
  if (GSTIN_KEYS.has(key)) return gstinForm(a) === gstinForm(b);
  if (key === "invoice_number" || key === "hsn_sac") return cleanText(a) === cleanText(b);
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

function sameField(key: string, a: AnyField, b: AnyField): boolean {
  const pa = present(a);
  const pb = present(b);
  if (!pa && !pb) return true; // neither reading has a value: nothing to compare
  if (pa !== pb) return false;
  if (typeof a.value === "number" && typeof b.value === "number") return sameNumber(a.value, b.value);
  if (typeof a.value === "string" && typeof b.value === "string") return sameText(key, a.value, b.value);
  return false;
}

// How many arithmetic problems the invoice has with these values. Fewer = more consistent.
function arithmeticScore(m: ModelOutput, opts: CheckOptions): number {
  const { extracted, items } = normalizeExtraction(m, { model: "recheck" });
  return runChecks(extracted, items, opts).filter((f) => f.code.startsWith("arithmetic_")).length;
}

interface Verdict {
  pick: "first" | "second" | "none";
  reason: string;
}

function decideText(key: string, a: ModelField<string>, b: ModelField<string>): Verdict {
  if (GSTIN_KEYS.has(key)) {
    const okA = checkGstin(gstinForm(a.value as string)).ok;
    const okB = checkGstin(gstinForm(b.value as string)).ok;
    if (okB && !okA) return { pick: "second", reason: "Only the second reading passes the GSTIN check digit." };
    if (okA && !okB) return { pick: "first", reason: "Only the first reading passes the GSTIN check digit." };
    return { pick: "none", reason: "Both readings differ and the GSTIN check digit cannot decide." };
  }
  if (key === "invoice_date") {
    const okA = normalizeIsoDate(a.value as string) !== null;
    const okB = normalizeIsoDate(b.value as string) !== null;
    if (okB && !okA) return { pick: "second", reason: "Only the second reading is a valid date." };
    if (okA && !okB) return { pick: "first", reason: "Only the first reading is a valid date." };
  }
  if (key === "hsn_sac") {
    const okA = normalizeHsn(a.value as string) !== null;
    const okB = normalizeHsn(b.value as string) !== null;
    if (okB && !okA) return { pick: "second", reason: "Only the second reading is a valid HSN/SAC." };
    if (okA && !okB) return { pick: "first", reason: "Only the first reading is a valid HSN/SAC." };
  }
  return { pick: "none", reason: "The two readings differ." };
}

export function reconcile(first: ModelOutput, second: ModelOutput, opts: CheckOptions): Reconciled {
  const merged = JSON.parse(JSON.stringify(first)) as ModelOutput;
  const agreed = new Set<string>();
  const disagreements: Disagreement[] = [];

  // A different document type means the readings are not about the same thing. Keep the first, ask a person.
  if (first.document_type !== second.document_type) {
    disagreements.push({ field: "document_type", first: first.document_type, second: second.document_type, resolution: "unresolved", reason: "The two readings disagree on the document type." });
    return { merged, agreed, disagreements, itemCountMismatch: false };
  }

  // Applies one field decision on the working copy `merged` (or on one of its items).
  const settle = (
    key: string,
    kind: "text" | "number",
    a: AnyField,
    b: AnyField,
    target: Record<string, AnyField>,
    score: ((candidate: AnyField) => number) | null,
    position?: number
  ): void => {
    const base = position ? { itemPosition: position } : {};
    if (sameField(key, a, b)) {
      if (present(a) && !position) agreed.add(key);
      if (present(a)) target[key] = { ...a, confidence: Math.min(a.confidence, b.confidence) } as AnyField; // lowest of the two readings
      return;
    }
    const record = (resolution: Disagreement["resolution"], reason: string) =>
      disagreements.push({ field: key, ...base, first: scalar(a), second: scalar(b), resolution, reason });

    // Free-text item fields: wording differences are normal. Keep a value, no flag, confidence untouched.
    if (position && SOFT_ITEM_FIELDS.has(key)) {
      const useSecond = !present(a) && present(b);
      target[key] = { ...(useSecond ? b : a) } as AnyField;
      record(useSecond ? "took_second" : "kept_first", "Wording differs between the two readings.");
      return;
    }

    // Only one reading found a value.
    if (present(a) !== present(b)) {
      if (present(a)) {
        target[key] = { ...a, confidence: Math.min(a.confidence, CONFIRM_ONLY_CONFIDENCE) } as AnyField;
        record("kept_first", R_NOT_CONFIRMED);
      } else {
        target[key] = { ...b, confidence: Math.min(b.confidence, CONFIRM_ONLY_CONFIDENCE) } as AnyField;
        record("took_second", R_ONLY_SECOND);
      }
      return;
    }

    // Both readings have a value and they differ. Try to prove which one is right.
    let verdict: Verdict = { pick: "none", reason: "The two readings differ." };
    if (kind === "text") {
      verdict = decideText(key, a as ModelField<string>, b as ModelField<string>);
    } else if (score) {
      const sa = score(a);
      const sb = score(b);
      if (sb < sa) verdict = { pick: "second", reason: "The second reading makes the invoice arithmetic consistent." };
      else if (sa < sb) verdict = { pick: "first", reason: "The first reading makes the invoice arithmetic consistent." };
      else verdict = { pick: "none", reason: "The two readings differ and the arithmetic cannot decide." };
    }
    if (verdict.pick === "second") {
      target[key] = { ...b } as AnyField;
      record("took_second", verdict.reason);
    } else if (verdict.pick === "first") {
      target[key] = { ...a } as AnyField;
      record("kept_first", verdict.reason);
    } else {
      target[key] = { ...a, confidence: Math.min(a.confidence, UNSURE_CONFIDENCE) } as AnyField;
      record("unresolved", verdict.reason);
    }
  };

  const headerScore = (key: string) => (candidate: AnyField) => {
    const probe = { ...merged, [key]: candidate } as ModelOutput;
    return arithmeticScore(probe, opts);
  };

  for (const key of HEADER_TEXT_FIELDS) {
    settle(key, "text", first[key], second[key], merged as unknown as Record<string, AnyField>, null);
  }
  for (const key of HEADER_AMOUNT_FIELDS) {
    settle(key, "number", first[key], second[key], merged as unknown as Record<string, AnyField>, headerScore(key));
  }

  // Optional extras (exchange rate, TCS, TDS, pre-tax charges, round-off; IRN, ack no, e-way bill no): compared like the
  // other fields when either reading has them. A reading without the field counts as "missing".
  const none: ModelField<number> = { status: "missing", value: null, confidence: 1 };
  const noneText: ModelField<string> = { status: "missing", value: null, confidence: 1 };
  const mergedAny = merged as unknown as Record<string, AnyField>;
  for (const key of OPTIONAL_AMOUNT_FIELDS) {
    if (!first[key] && !second[key]) continue;
    settle(key, "number", first[key] ?? none, second[key] ?? none, mergedAny, key === "exchange_rate" ? null : headerScore(key));
  }
  for (const key of OPTIONAL_TEXT_FIELDS) {
    if (!first[key] && !second[key]) continue;
    settle(key, "text", first[key] ?? noneText, second[key] ?? noneText, mergedAny, null);
  }

  // Line items are only compared when both readings found the same number of rows. Rows are never matched by guesswork.
  let itemCountMismatch = false;
  if (first.line_items.length !== second.line_items.length) {
    itemCountMismatch = true;
  } else {
    first.line_items.forEach((fi: ModelItem, idx: number) => {
      const si = second.line_items[idx];
      const row = merged.line_items[idx] as unknown as Record<string, AnyField>;
      const itemScore = (key: string) => (candidate: AnyField) => {
        const probe = JSON.parse(JSON.stringify(merged)) as ModelOutput;
        (probe.line_items[idx] as unknown as Record<string, AnyField>)[key] = candidate;
        return arithmeticScore(probe, opts);
      };
      for (const key of ITEM_TEXT_FIELDS) settle(key, "text", fi[key], si[key], row, null, idx + 1);
      for (const key of ITEM_NUMBER_FIELDS) settle(key, "number", fi[key], si[key], row, itemScore(key), idx + 1);
      for (const key of ITEM_OPTIONAL_TEXT_FIELDS) {
        if (fi[key] || si[key]) settle(key, "text", fi[key] ?? noneText, si[key] ?? noneText, row, null, idx + 1);
      }
    });
  }

  return { merged, agreed, disagreements, itemCountMismatch };
}

// Review flags that describe what the second check found. Only real problems are warnings.
export function recheckFlags(r: Reconciled): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const pair = (d: Disagreement) => ({ position: d.itemPosition, field: d.field, first: d.first, second: d.second });
  // "Problem" = nothing proved which reading is right, or only one reading saw a value.
  const isProblem = (d: Disagreement) => d.resolution === "unresolved" || d.reason === R_NOT_CONFIRMED || d.reason === R_ONLY_SECOND;
  // "Fixed" = the second reading replaced the first and a rule proved it better.
  const isFixed = (d: Disagreement) => d.resolution === "took_second" && !isProblem(d);

  for (const d of r.disagreements.filter((x) => !x.itemPosition)) {
    if (isProblem(d)) {
      flags.push({
        code: "recheck_mismatch",
        severity: "warning",
        field: d.field,
        message: d.reason === R_ONLY_SECOND
          ? "Only the second check found a value here. Compare it with the original."
          : "Two readings of the document gave different values and nothing could prove which is right. Compare with the original.",
        details: { first: d.first, second: d.second },
      });
    } else if (isFixed(d)) {
      flags.push({
        code: "recheck_corrected",
        severity: "info",
        field: d.field,
        message: "The second check corrected this value after the first reading. " + d.reason,
        details: { first: d.first, second: d.second },
      });
    }
  }

  const items = r.disagreements.filter((d) => d.itemPosition);
  const problems = items.filter((d) => isProblem(d) && !SOFT_ITEM_FIELDS.has(d.field));
  if (problems.length > 0) {
    flags.push({
      code: "recheck_mismatch_item",
      severity: "warning",
      message: `${problems.length} item value(s) were read differently the second time. Compare them with the original.`,
      details: { fields: problems.slice(0, 50).map(pair) },
    });
  }
  const fixed = items.filter(isFixed);
  if (fixed.length > 0) {
    flags.push({
      code: "recheck_corrected_item",
      severity: "info",
      message: `The second check corrected ${fixed.length} item value(s).`,
      details: { fields: fixed.slice(0, 50).map(pair) },
    });
  }
  if (r.itemCountMismatch) {
    flags.push({ code: "recheck_item_count", severity: "warning", message: "The two readings found a different number of item rows. The first reading's rows were kept. Compare the item table with the original." });
  }
  return flags;
}
