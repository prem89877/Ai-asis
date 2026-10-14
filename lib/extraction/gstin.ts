// GSTIN validation.
//  - validateGstin(): REPORTS only. It never changes a GSTIN. The raw value (upper-cased, spaces removed) is always returned
//    as `gstin`, and a possible correction is returned separately as `proposed`, for a reviewer to see.
//  - suggestGstinFixes(): only SUGGESTS (check digit or one look-alike character). Never written automatically.
// Why nothing is replaced: a GSTIN that fails the layout or the check digit may simply be printed that way on the invoice
// (print error, sample invoice, old number). Replacing it with a number that happens to pass the Modulo-36 test would put a
// GSTIN into the books that the invoice does not show. A passing layout + check digit also proves nothing about whether the
// number really exists: only the GST portal lookup (gst-portal.ts) can say that.
// A value is replaced only by evidence from the document itself: a source re-read whose quoted printed text contains the new
// value (source-verify.ts), or a whole reading of the document that passes the check (party-check.ts).
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

export type GstinValidationStatus =
  | "valid" // layout and check digit pass (this is NOT proof that the GSTIN exists)
  | "missing" // nothing was extracted
  | "format_invalid" // wrong length or layout: kept as read, needs review
  | "checksum_failed"; // layout is fine, check digit does not match: kept as read, unresolved

export interface GstinValidation {
  status: GstinValidationStatus;
  valid: boolean;
  raw: string; // exactly what was extracted (only upper-cased and stripped of spaces)
  gstin: string; // the value to save: ALWAYS the raw value, never a replacement
  proposed?: string[]; // possible corrections. Never applied; shown to the reviewer only.
}

export function validateGstin(input: string | null | undefined): GstinValidation {
  const raw = cleanGstin(input ?? "");
  if (raw === "") return { status: "missing", valid: false, raw, gstin: raw };
  const check = checkGstin(raw);
  if (check.ok) return { status: "valid", valid: true, raw, gstin: raw };
  const proposed = suggestGstinFixes(raw);
  return { status: check.reason === "checksum" ? "checksum_failed" : "format_invalid", valid: false, raw, gstin: raw, ...(proposed.length ? { proposed } : {}) };
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
