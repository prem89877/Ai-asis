// ONE list of GST rates, date-aware. It replaces three lists that had drifted apart (COMMON_GST_RATES in review/gst.ts,
// GST_SLABS in source-verify.ts, and the rates quoted in the prompt).
//
// GST 2.0: from 22 September 2025 the 12% and 28% slabs no longer exist; the standard slabs are 5%, 18% and 40% (plus 0% and the
// special rates). An invoice dated on or after that day that still shows 12% or 28% is flagged for a person to check.
// Rates change by notification (and some supplies keep an old rate for a transition), so this is only ever a flag, never a change
// of a value. Please confirm the rule with your CA. See docs/GST_ENGINE.md.

export const GST_RATE_CHANGE_DATE = "2025-09-22";

const SPECIAL_RATES = [0.1, 0.25, 1, 1.5, 3, 6, 7.5];
export const RETIRED_SLABS: readonly number[] = [12, 28]; // gone from GST_RATE_CHANGE_DATE
export const NEW_SLAB = 40; // exists from GST_RATE_CHANGE_DATE

// Rates valid on an invoice dated BEFORE the change date.
export const LEGACY_GST_RATES: readonly number[] = [0, ...SPECIAL_RATES, 5, 12, 18, 28].sort((a, b) => a - b);
// Rates valid on an invoice dated ON OR AFTER the change date.
export const CURRENT_GST_RATES: readonly number[] = [0, ...SPECIAL_RATES, 5, 18, NEW_SLAB].sort((a, b) => a - b);
// Every rate that is ever valid: used when the invoice date is not known.
export const ALL_GST_RATES: readonly number[] = Array.from(new Set([...LEGACY_GST_RATES, ...CURRENT_GST_RATES])).sort((a, b) => a - b);

export type RateVerdict =
  | "ok" // a rate that exists on that date (or on any date, when the date is unknown)
  | "retired" // 12% / 28% on an invoice dated on or after 22 Sep 2025
  | "not_yet" // 40% on an invoice dated before 22 Sep 2025
  | "unknown"; // not a GST rate at all

function ymd(date: string | null | undefined): string | null {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(date) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function checkGstRate(rate: number, invoiceDate: string | null | undefined): RateVerdict {
  const d = ymd(invoiceDate);
  if (d === null) return ALL_GST_RATES.includes(rate) ? "ok" : "unknown";
  if (d >= GST_RATE_CHANGE_DATE) {
    if (RETIRED_SLABS.includes(rate)) return "retired";
    return CURRENT_GST_RATES.includes(rate) ? "ok" : "unknown";
  }
  if (rate === NEW_SLAB) return "not_yet";
  return LEGACY_GST_RATES.includes(rate) ? "ok" : "unknown";
}

// Short text for the review message.
export function rateDateNote(verdict: RateVerdict, rate: number): string {
  if (verdict === "retired") return `The ${rate}% slab was removed from 22 September 2025 (GST 2.0: 5%, 18% and 40%), but this invoice is dated after that. Check the rate on the original.`;
  if (verdict === "not_yet") return `The ${rate}% slab only exists from 22 September 2025, but this invoice is dated before that. Check the rate or the date on the original.`;
  return `The GST rate ${rate}% is not a commonly used rate. Check the original.`;
}
