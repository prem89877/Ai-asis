// GSTIN repair suggestions. Only SUGGESTS: a suggested value is never written into the invoice automatically.
// A suggestion is offered only when changing exactly ONE character gives a GSTIN that passes the format and the
// Modulo-36 check-digit test. The one character is either the check digit itself or a look-alike character.
import { checkGstin, gstinChecksumChar } from "./normalize.ts";

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
