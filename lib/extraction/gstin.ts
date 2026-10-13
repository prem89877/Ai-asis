// GSTIN repair.
//  - suggestGstinFixes(): only SUGGESTS (check digit or one look-alike character). Never written automatically.
//  - validateAndRepairGSTIN(): the one automatic repair allowed. It may replace ONLY the 15th character (the
//    check digit) and only when the first 14 characters already have a valid GSTIN layout. State code, PAN and
//    entity number are never touched automatically, because a wrong check digit cannot tell us which of the
//    other characters (if any) was misread.
// A suggestion is offered only when changing exactly ONE character gives a GSTIN that passes the format and the
// Modulo-36 check-digit test. The one character is either the check digit itself or a look-alike character.
import { checkGstin, gstinChecksumChar } from "./normalize.ts";

// Layout of the first 14 characters: state code (2 digits) + PAN (5 letters, 4 digits, 1 letter) + entity number + "Z".
const GSTIN_PREFIX_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z$/;

export function cleanGstin(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

// Modulo-36 check digit for position 15, or null when the first 14 characters are not a valid GSTIN layout.
export function computeGstinCheckDigit(first14: string): string | null {
  if (!GSTIN_PREFIX_RE.test(first14)) return null;
  return gstinChecksumChar(first14);
}

export type GstinRepairStatus =
  | "valid" // already passes layout and check digit
  | "auto_corrected" // only the 15th character was wrong and was replaced
  | "not_repairable"; // wrong length / layout, or a check digit that cannot be derived

export interface GstinRepairResult {
  status: GstinRepairStatus;
  valid: boolean; // the returned `gstin` passes the layout and the Modulo-36 test
  auto_corrected: boolean;
  gstin_auto_corrected: boolean; // audit flag, same as auto_corrected
  gstin: string; // value to save: the corrected GSTIN, or the cleaned input when nothing was changed
  original_raw_gstin: string; // exactly what was extracted (only upper-cased and stripped of spaces)
  corrected_char?: { position: 15; from: string; to: string };
  reason?: "length" | "format";
}

export interface RepairOptions {
  // When false the check digit is still computed and reported, but nothing is replaced. Callers pass false for a
  // reading that is not trusted (low OCR confidence, or not confirmed by a second reading).
  allowRepair?: boolean;
}

export function validateAndRepairGSTIN(gstinString: string, opts: RepairOptions = {}): GstinRepairResult {
  const original = cleanGstin(gstinString ?? "");
  const base = { original_raw_gstin: original, gstin: original };
  if (original.length !== 15) return { ...base, status: "not_repairable", valid: false, auto_corrected: false, gstin_auto_corrected: false, reason: "length" };
  if (checkGstin(original).ok) return { ...base, status: "valid", valid: true, auto_corrected: false, gstin_auto_corrected: false };
  const digit = computeGstinCheckDigit(original.slice(0, 14));
  if (digit === null) return { ...base, status: "not_repairable", valid: false, auto_corrected: false, gstin_auto_corrected: false, reason: "format" };
  if (opts.allowRepair === false) return { ...base, status: "not_repairable", valid: false, auto_corrected: false, gstin_auto_corrected: false };
  const fixed = original.slice(0, 14) + digit;
  return {
    status: "auto_corrected", valid: true, auto_corrected: true, gstin_auto_corrected: true,
    gstin: fixed, original_raw_gstin: original,
    corrected_char: { position: 15, from: original[14], to: digit },
  };
}

export const GSTIN_AUTO_CORRECTED_LABEL = "GSTIN Auto-Corrected (Checksum Fixed)";

// Pairs that scanners and OCR often confuse. Applied in both directions.
const LOOKALIKE_PAIRS: readonly [string, string][] = [
  ["O", "0"], ["D", "0"], ["Q", "0"], ["I", "1"], ["L", "1"], ["Z", "2"], ["S", "5"], ["B", "8"], ["G", "6"], ["A", "4"], ["T", "7"],
];

const LOOKALIKES: Record<string, string[]> = {};
for (const [a, b] of LOOKALIKE_PAIRS) {
  (LOOKALIKES[a] ??= []).push(b);
  (LOOKALIKES[b] ??= []).push(a);
}

export const MAX_GSTIN_SUGGESTIONS = 5;

export function suggestGstinFixes(raw: string): string[] {
  const g = raw.replace(/\s+/g, "").toUpperCase();
  if (g.length !== 15 || checkGstin(g).ok) return [];
  const found = new Set<string>();
  const accept = (candidate: string) => {
    if (candidate !== g && checkGstin(candidate).ok) found.add(candidate);
  };

  // 1. Only the check digit (15th character) is wrong.
  const check = gstinChecksumChar(g.slice(0, 14));
  if (check) accept(g.slice(0, 14) + check);

  // 2. One look-alike character is wrong. Position 15 is covered by 1, because its correct value follows from the first 14.
  for (let i = 0; i < 14; i++) {
    for (const alt of LOOKALIKES[g[i]] ?? []) accept(g.slice(0, i) + alt + g.slice(i + 1));
  }
  return Array.from(found).slice(0, MAX_GSTIN_SUGGESTIONS);
}

// Text added to a GSTIN flag when a suggestion exists.
export function suggestionText(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  return suggestions.length === 1 ? ` Possible correct GSTIN: ${suggestions[0]}.` : ` Possible correct GSTINs: ${suggestions.join(", ")}.`;
}
