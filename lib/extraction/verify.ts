// Second-check layer. The model reads the invoice twice; this file compares the two readings in plain code.
// Rules:
//  - Same value in both readings  => kept, and remembered as "confirmed by recheck".
//  - Different values             => a rule that can be proven decides (GSTIN check digit, valid date,
//                                    arithmetic of the invoice). If nothing can decide, the FIRST value is kept,
//                                    its confidence is lowered and a review flag shows both values.
//  - The model never gets the last word and no value is ever invented here.
import { checkGstin, cleanText, normalizeHsn, normalizeIsoDate, normalizeExtraction } from "./normalize.ts";
import { runChecks } from "./checks.ts";
import { validateInvoiceTotals } from "./gst-engine.ts";
import { cleanIdentifier } from "./identifiers.ts";
import type { IdentifierKind } from "./identifiers.ts";
import type { CheckOptions } from "./checks.ts";
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS, ITEM_NUMBER_FIELDS, ITEM_OPTIONAL_TEXT_FIELDS, ITEM_TEXT_FIELDS, OPTIONAL_AMOUNT_FIELDS, OPTIONAL_TEXT_FIELDS } from "./types.ts";
import type { KeyFigures, ModelField, ModelItem, ModelOutput, PartiesReading, ReviewFlag } from "./types.ts";

export type Scalar = string | number | null;

export interface Disagreement {
  field: string;
  itemPosition?: number;
  first: Scalar;
  second: Scalar;
  others?: Scalar[]; // further different values when more than two readings were compared
  resolution: "kept_first" | "took_second" | "unresolved";
  reason: string;
}

export interface Reconciled {
  merged: ModelOutput;
  agreed: Set<string>; // header fields where both readings gave the same value
  disagreements: Disagreement[];
  itemCountMismatch: boolean;
  // Set when the readings found different numbers of rows and the difference was settled: by the count most readings agree on
  // ("majority") or by the one reading whose rows add up to the invoice taxable value ("totals").
  itemCountResolved?: "majority" | "totals" | null;
  itemCounts?: number[];
}

const R_NOT_CONFIRMED = "The second reading could not confirm this value.";
const R_ONLY_SECOND = "Only the second reading found a value here.";
const R_MAJORITY = "Most of the readings agree on this value.";
const UNSURE_CONFIDENCE = 0.5; // value kept although the second reading disagrees
const CONFIRM_ONLY_CONFIDENCE = 0.6; // value seen in one reading only

const GSTIN_KEYS = new Set(["supplier_gstin", "buyer_gstin"]);
const IDENTIFIER_KEYS = new Set<string>(["irn", "ack_no", "eway_bill_no"]);
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
  if (IDENTIFIER_KEYS.has(key)) return cleanIdentifier(key as IdentifierKind, a).value === cleanIdentifier(key as IdentifierKind, b).value;
  if (key === "invoice_number" || key === "hsn_sac") return cleanText(a) === cleanText(b);
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

export function sameField(key: string, a: AnyField, b: AnyField): boolean {
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
  if (IDENTIFIER_KEYS.has(key)) {
    const okA = cleanIdentifier(key as IdentifierKind, a.value as string).valid;
    const okB = cleanIdentifier(key as IdentifierKind, b.value as string).valid;
    if (okB && !okA) return { pick: "second", reason: "Only the second reading has the correct format and length." };
    if (okA && !okB) return { pick: "first", reason: "Only the first reading has the correct format and length." };
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

// ---- Voting over three or more readings ------------------------------------------------------------------------------------
// Used when the audit reading (and/or the key-figures reading) is on. Same principles as reconcile(), with a vote on top:
//   - same value in every reading                      => kept, remembered as confirmed;
//   - most readings agree (2 of 3, 3 of 4, ...)        => that value wins, silently;
//   - no majority                                      => a rule that can be proven decides (check digit, valid date,
//                                                         HSN, identifier length, invoice arithmetic);
//   - nothing can decide                               => FIRST reading kept, confidence lowered, a review flag shows the values.
// A reading that has no value for a field never outvotes a reading that has one: absence is not evidence of a different value.

function textValid(key: string, v: string): boolean | null {
  if (GSTIN_KEYS.has(key)) return checkGstin(gstinForm(v)).ok;
  if (IDENTIFIER_KEYS.has(key)) return cleanIdentifier(key as IdentifierKind, v).valid;
  if (key === "invoice_date") return normalizeIsoDate(v) !== null;
  if (key === "hsn_sac") return normalizeHsn(v) !== null;
  return null;
}

// Does the item table of this reading add up to the invoice taxable value? null = cannot be told.
function subtotalOk(m: ModelOutput): boolean | null {
  const n = normalizeExtraction(m, { model: "recheck" });
  const header = n.extracted.taxable_amount;
  if (header === null || n.items.length === 0 || n.items.some((it) => it.taxable_amount === null)) return null;
  const t = validateInvoiceTotals(n.extracted, n.items, { tolerancePaise: 100 });
  return !t.flags.some((f) => f.code === "arithmetic_subtotal_mismatch");
}

interface Group {
  rep: AnyField;
  members: number[]; // indexes into the vote list
}

// `parties` = the blind parties readings. They vote only on the two GSTINs (names are compared softly in final-audit.ts, because a
// printed name may legitimately be shortened or extended: "Acme Traders" / "Acme Traders Pvt Ltd").
export function reconcileMany(readings: ModelOutput[], opts: CheckOptions, keyFigures?: KeyFigures | null, parties?: PartiesReading[] | null): Reconciled {
  const first = readings[0];
  const merged = JSON.parse(JSON.stringify(first)) as ModelOutput;
  const agreed = new Set<string>();
  const disagreements: Disagreement[] = [];

  // Document type: the readings must be about the same kind of document.
  const typeCount = new Map<string, number>();
  for (const r of readings) typeCount.set(r.document_type, (typeCount.get(r.document_type) ?? 0) + 1);
  if (typeCount.size > 1) {
    const top = Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]);
    if (top[0][1] >= 2 && top[0][1] > top[1][1]) {
      merged.document_type = top[0][0] as ModelOutput["document_type"];
    } else {
      disagreements.push({ field: "document_type", first: first.document_type, second: readings.find((r) => r.document_type !== first.document_type)?.document_type ?? null, resolution: "unresolved", reason: "The readings disagree on the document type." });
      return { merged, agreed, disagreements, itemCountMismatch: false };
    }
  }

  // One field, many votes. `fields[i] === undefined` = that reading abstains (key figures only).
  const vote = (
    key: string,
    kind: "text" | "number",
    fields: (AnyField | undefined)[],
    target: Record<string, AnyField>,
    score: ((candidate: AnyField) => number) | null,
    position?: number
  ): void => {
    const base = position ? { itemPosition: position } : {};
    const cast = fields.map((f) => f);
    const participants = cast.filter((f) => f !== undefined).length;
    const groups: Group[] = [];
    cast.forEach((f, i) => {
      if (!f || !present(f)) return;
      const g = groups.find((x) => sameField(key, x.rep, f));
      if (g) g.members.push(i);
      else groups.push({ rep: f, members: [i] });
    });
    if (groups.length === 0) return; // nobody has a value: the merged copy already carries the first reading's status

    const minConf = (g: Group) => Math.min(...g.members.map((i) => (cast[i] as AnyField).confidence));
    const scalarsOf = (): { first: Scalar; second: Scalar; others: Scalar[] } => {
      const vals: Scalar[] = [];
      for (const g of groups) vals.push(scalar(g.rep));
      const f0 = cast[0] && present(cast[0] as AnyField) ? scalar(cast[0] as AnyField) : null;
      const rest = groups.filter((g) => !g.members.includes(0)).map((g) => scalar(g.rep));
      return { first: f0, second: rest[0] ?? null, others: rest.slice(1) };
    };
    const record = (resolution: Disagreement["resolution"], reason: string) => {
      const { first: a, second: b, others } = scalarsOf();
      disagreements.push({ field: key, ...base, first: a, second: b, ...(others.length ? { others } : {}), resolution, reason });
    };
    const ordered = [...groups].sort((a, b) => b.members.length - a.members.length || a.members[0] - b.members[0]);
    const top = ordered[0];
    const runnerUp = ordered[1];
    const majority = top.members.length >= 2 && (!runnerUp || top.members.length > runnerUp.members.length);

    // Unanimous: every participating reading has the same value.
    if (groups.length === 1 && top.members.length === participants) {
      if (participants >= 2 && !position) agreed.add(key);
      target[key] = { ...top.rep, confidence: minConf(top) } as AnyField;
      return;
    }

    // Free-text item fields: wording differences are normal. Majority or first value, no flag, confidence untouched.
    if (position && SOFT_ITEM_FIELDS.has(key)) {
      const pick = majority ? top : groups.find((g) => g.members.includes(0)) ?? top;
      target[key] = { ...pick.rep } as AnyField;
      record(pick.members.includes(0) ? "kept_first" : "took_second", "Wording differs between the readings.");
      return;
    }

    if (majority) {
      target[key] = { ...top.rep, confidence: minConf(top) } as AnyField;
      if (!top.members.includes(0)) record("took_second", R_MAJORITY);
      return;
    }

    // Only one reading has a value and the others have none.
    if (groups.length === 1) {
      if (participants < 2) return;
      const only = top.members[0];
      target[key] = { ...top.rep, confidence: Math.min((cast[only] as AnyField).confidence, CONFIRM_ONLY_CONFIDENCE) } as AnyField;
      record(only === 0 ? "kept_first" : "took_second", only === 0 ? R_NOT_CONFIRMED : R_ONLY_SECOND);
      return;
    }

    // Different values and no majority: prove which one is right, if a rule can.
    let proven: Group | null = null;
    let reason = "The readings differ.";
    if (kind === "text") {
      const verdicts = groups.map((g) => textValid(key, g.rep.value as string));
      const validIdx = verdicts.map((v, i) => (v === true ? i : -1)).filter((i) => i >= 0);
      if (verdicts.some((v) => v !== null) && validIdx.length === 1) {
        proven = groups[validIdx[0]];
        reason = key === "invoice_date" || key === "hsn_sac" ? "Only one reading is valid." : GSTIN_KEYS.has(key) ? "Only one reading passes the GSTIN check digit." : "Only one reading has the correct format and length.";
      }
    } else if (score) {
      const scores = groups.map((g) => score(g.rep));
      const min = Math.min(...scores);
      const best = scores.map((v, i) => (v === min ? i : -1)).filter((i) => i >= 0);
      if (best.length === 1) {
        proven = groups[best[0]];
        reason = "This reading makes the invoice arithmetic consistent.";
      }
    }
    if (proven) {
      target[key] = { ...proven.rep } as AnyField;
      record(proven.members.includes(0) ? "kept_first" : "took_second", reason);
      return;
    }
    const keep = groups.find((g) => g.members.includes(0)) ?? top;
    target[key] = { ...keep.rep, confidence: Math.min(minConf(keep), UNSURE_CONFIDENCE) } as AnyField;
    record("unresolved", "The readings differ and nothing could prove which is right.");
  };

  const kf = (keyFigures ?? null) as Record<string, AnyField | undefined> | null;
  const headerScore = (key: string) => (candidate: AnyField) => arithmeticScore({ ...merged, [key]: candidate } as ModelOutput, opts);
  const mergedAny = merged as unknown as Record<string, AnyField>;
  const none: ModelField<number> = { status: "missing", value: null, confidence: 1 };
  const noneText: ModelField<string> = { status: "missing", value: null, confidence: 1 };

  for (const key of HEADER_TEXT_FIELDS) {
    const fields: (AnyField | undefined)[] = readings.map((r) => r[key]);
    if (parties && GSTIN_KEYS.has(key)) for (const p of parties) fields.push((p as Record<string, AnyField | undefined>)[key]);
    vote(key, "text", fields, mergedAny, null);
  }
  for (const key of HEADER_AMOUNT_FIELDS) {
    const fields: (AnyField | undefined)[] = readings.map((r) => r[key]);
    if (kf) fields.push(kf[key]);
    vote(key, "number", fields, mergedAny, headerScore(key));
  }
  for (const key of OPTIONAL_AMOUNT_FIELDS) {
    if (!readings.some((r) => r[key]) && !(kf && kf[key])) continue;
    const fields: (AnyField | undefined)[] = readings.map((r) => r[key] ?? none);
    if (kf) fields.push(kf[key]);
    vote(key, "number", fields, mergedAny, key === "exchange_rate" ? null : headerScore(key));
  }
  for (const key of OPTIONAL_TEXT_FIELDS) {
    if (!readings.some((r) => r[key]) && !(kf && kf[key])) continue;
    const fields: (AnyField | undefined)[] = readings.map((r) => r[key] ?? noneText);
    if (kf) fields.push(kf[key]);
    vote(key, "text", fields, mergedAny, null);
  }

  // Item rows. The number of rows is voted first; rows are never matched by guesswork.
  const counts = readings.map((r) => r.line_items.length);
  let rowSet = readings.map((_, i) => i);
  let itemCountMismatch = false;
  let itemCountResolved: "majority" | "totals" | null = null;
  if (new Set(counts).size > 1) {
    itemCountMismatch = true;
    const tally = new Map<number, number[]>();
    counts.forEach((c, i) => tally.set(c, [...(tally.get(c) ?? []), i]));
    const sorted = Array.from(tally.values()).sort((a, b) => b.length - a.length || a[0] - b[0]);
    if (sorted[0].length >= 2 && sorted[0].length > (sorted[1]?.length ?? 0)) {
      rowSet = sorted[0];
      itemCountResolved = "majority";
    } else {
      // No majority: the one reading whose rows add up to the invoice taxable value (with the voted header) wins.
      const ties = readings.map((r, i) => ({ i, ok: subtotalOk({ ...merged, line_items: r.line_items } as ModelOutput) })).filter((x) => x.ok === true);
      if (ties.length === 1) {
        rowSet = [ties[0].i];
        itemCountResolved = "totals";
      } else {
        rowSet = [0];
      }
    }
    merged.line_items = JSON.parse(JSON.stringify(readings[rowSet[0]].line_items)) as ModelItem[];
  }
  if (rowSet.length >= 2 || itemCountResolved === null) {
    const rows = readings[rowSet[0]].line_items.length;
    for (let idx = 0; idx < rows; idx++) {
      const sources = rowSet.map((i) => readings[i].line_items[idx]);
      const row = merged.line_items[idx] as unknown as Record<string, AnyField>;
      const itemScore = (key: string) => (candidate: AnyField) => {
        const probe = JSON.parse(JSON.stringify(merged)) as ModelOutput;
        (probe.line_items[idx] as unknown as Record<string, AnyField>)[key] = candidate;
        return arithmeticScore(probe, opts);
      };
      for (const key of ITEM_TEXT_FIELDS) vote(key, "text", sources.map((it) => it[key]), row, null, idx + 1);
      for (const key of ITEM_NUMBER_FIELDS) vote(key, "number", sources.map((it) => it[key]), row, itemScore(key), idx + 1);
      for (const key of ITEM_OPTIONAL_TEXT_FIELDS) {
        if (sources.some((it) => it[key])) vote(key, "text", sources.map((it) => it[key] ?? noneText), row, null, idx + 1);
      }
    }
  }

  return { merged, agreed, disagreements, itemCountMismatch, itemCountResolved, itemCounts: counts };
}

// Review flags that describe what the second check found. Only real problems are warnings.
export function recheckFlags(r: Reconciled): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const pair = (d: Disagreement) => ({ position: d.itemPosition, field: d.field, first: d.first, second: d.second, ...(d.others && d.others.length ? { others: d.others } : {}) });
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
        details: { first: d.first, second: d.second, ...(d.others && d.others.length ? { others: d.others } : {}) },
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
    if (r.itemCountResolved) {
      flags.push({
        code: "recheck_item_count_resolved", severity: "info",
        message: r.itemCountResolved === "majority"
          ? "The readings found a different number of item rows. The row count most readings agree on was used."
          : "The readings found a different number of item rows. The reading whose item rows add up to the invoice taxable value was used.",
        details: { counts: r.itemCounts ?? [] },
      });
    } else {
      flags.push({ code: "recheck_item_count", severity: "warning", message: "The readings found a different number of item rows. The first reading's rows were kept. Compare the item table with the original.", details: { counts: r.itemCounts ?? [] } });
    }
  }
  return flags;
}
