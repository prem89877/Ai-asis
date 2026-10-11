// Field-level scoring of extraction output against hand-written ground truth.
// Used by scripts/eval-extraction.mjs. It reports counts per field, not a single "accuracy" claim.
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS, ITEM_NUMBER_FIELDS, ITEM_TEXT_FIELDS } from "./types.ts";
import type { ModelField, ModelOutput } from "./types.ts";

// Truth value: a string/number = must be read exactly; null = must NOT be present (missing on the document).
export type TruthValue = string | number | null;
export interface Truth {
  [field: string]: unknown;
  line_items?: Record<string, TruthValue>[];
}

export type Verdict = "correct" | "wrong" | "abstained" | "invented" | "correct_missing";

export interface FieldTally {
  correct: number;
  wrong: number; // a value was given but it differs from the truth
  abstained: number; // truth has a value, model said missing/unreadable
  invented: number; // truth says absent, model gave a value
  correct_missing: number; // truth absent, model said missing/unreadable
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function judge(truth: TruthValue, field: ModelField<string | number> | undefined): Verdict {
  const present = field !== undefined && field.status === "present" && field.value !== null;
  if (truth === null) return present ? "invented" : "correct_missing";
  if (!present) return "abstained";
  const v = field!.value as string | number;
  if (typeof truth === "number") return typeof v === "number" && Math.abs(v - truth) < 0.005 ? "correct" : "wrong";
  return typeof v === "string" && norm(v) === norm(truth) ? "correct" : "wrong";
}

export function emptyTally(): FieldTally {
  return { correct: 0, wrong: 0, abstained: 0, invented: 0, correct_missing: 0 };
}

export interface ScoreReport {
  fields: Record<string, FieldTally>;
  itemFields: Record<string, FieldTally>;
  itemCount: { expected: number; extracted: number; match: boolean };
}

export function scoreExtraction(truth: Truth, out: ModelOutput): ScoreReport {
  const fields: Record<string, FieldTally> = {};
  const itemFields: Record<string, FieldTally> = {};
  for (const key of [...HEADER_TEXT_FIELDS, ...HEADER_AMOUNT_FIELDS]) {
    if (!(key in truth)) continue; // only score what the truth file states
    const v = judge(truth[key] as TruthValue, out[key] as ModelField<string | number>);
    (fields[key] ??= emptyTally())[v] += 1;
  }
  const expected = truth.line_items ?? [];
  const got = out.line_items ?? [];
  expected.forEach((t, i) => {
    for (const key of [...ITEM_TEXT_FIELDS, ...ITEM_NUMBER_FIELDS]) {
      if (!(key in t)) continue;
      const f = got[i]?.[key] as ModelField<string | number> | undefined;
      const v = judge(t[key], f);
      (itemFields[key] ??= emptyTally())[v] += 1;
    }
  });
  return { fields, itemFields, itemCount: { expected: expected.length, extracted: got.length, match: expected.length === got.length } };
}

export function mergeTallies(into: Record<string, FieldTally>, from: Record<string, FieldTally>) {
  for (const [k, t] of Object.entries(from)) {
    const dst = (into[k] ??= emptyTally());
    for (const v of Object.keys(t) as (keyof FieldTally)[]) dst[v] += t[v];
  }
}
