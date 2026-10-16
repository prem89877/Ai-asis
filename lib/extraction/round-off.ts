// The round-off window, defined once. The review engine (gst-engine.ts) and the Tally export (lib/tally/build.ts) both use it, so an
// invoice the engine passed as "total matches" is never skipped by the export. No imports: also safe for the browser bundle.
export const ROUND_OFF_MAX_PAISE = 200; // INR 2.00
export const ROUND_OFF_MAX_PERCENT = 1; // never more than 1% of the invoice value
