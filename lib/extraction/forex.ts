// Foreign currency invoices (import / cross-border): decides WHICH exchange rate an invoice uses and converts it to INR.
// Rule order (the first that applies wins):
//   1. a rate PRINTED on the invoice is always the invoice's own rate. It is never replaced. It is only cross-checked against the
//      public reference rate for the invoice date: a big gap usually means a misread digit, so it is flagged for a person.
//   2. no printed rate, but at least two lines agree on one conversion rate: that rate is the supplier's own rate. It keeps the strict
//      line check (0.05 %), and is cross-checked against the reference rate like a printed one.
//   3. no printed rate and no agreement: the reference rate of the invoice date is fetched (fx-rates.ts) and used, marked source
//      "fetched", and an info note tells the reviewer. Line / total checks then accept 3 % around it (see rateToleranceFor).
//   4. nothing could be fetched (offline, unsupported currency, no date): nothing is guessed. The old behaviour stays (rate implied
//      by the lines, or the "rate unverified" note).
// Only adds a rate, a note and a summary. It never changes any amount read from the document.
import { hasRate, impliedRate, lineCandidates, FETCHED_RATE_REL_TOLERANCE } from "./arithmetic.ts";
import { toPaise } from "./normalize.ts";
import type { FxLookup, FxFailure, FxRate } from "./fx-rates.ts";
import type { FieldMeta, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

// A printed rate this far (fraction) from the reference rate is flagged as a warning.
export const PRINTED_RATE_DEVIATION_WARN = 0.05;

export type RateOrigin = "printed" | "from_lines" | "fetched" | "none";
export type AmountBasis = "invoice_currency" | "inr" | "unknown";

export interface ForexConversion {
  basis: AmountBasis; // are the printed amounts in the invoice currency or already in INR
  taxable_inr: number | null;
  tax_inr: number | null;
  total_inr: number | null;
  total_foreign: number | null;
}

export interface ForexSummary {
  currency: string;
  rate_origin: RateOrigin;
  rate: number | null; // the rate the invoice is validated with
  reference_rate?: number; // fetched reference rate (also kept when the invoice printed its own)
  rate_date?: string; // date the reference rate was published for
  requested_date?: string; // invoice date
  source?: string;
  source_label?: string;
  deviation_pct?: number; // |printed - reference| / reference, in percent
  lookup_failed?: FxFailure;
  conversion?: ForexConversion;
}

export interface ForexResult {
  exchangeRate: number | null; // set only when a rate was fetched (the invoice printed none)
  fieldMeta: FieldMeta | null;
  flags: ReviewFlag[];
  summary: ForexSummary | null; // null for INR invoices
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Looks at the lines to see in which currency the printed taxable values are:
// qty x price (less discount) reproduces the taxable value -> invoice currency; x rate reproduces it -> already INR.
export function detectBasis(items: StoredItem[], rate: number, tolerancePaise: number, relTol = FETCHED_RATE_REL_TOLERANCE): AmountBasis {
  let plain = 0;
  let converted = 0;
  for (const it of items) {
    if (it.quantity === null || it.unit_price === null || it.taxable_amount === null) continue;
    const actual = toPaise(it.taxable_amount);
    const cands = lineCandidates(it);
    if (cands.length === 0) continue;
    const gross = it.quantity * it.unit_price;
    const nets = [...cands.map((c) => c.net), gross];
    const isPlain = nets.some((n) => Math.abs(actual - toPaise(n)) <= tolerancePaise);
    const isConv = nets.some((n) => Math.abs(actual - toPaise(n * rate)) <= tolerancePaise + Math.round(Math.abs(toPaise(n * rate)) * relTol));
    if (isPlain && !isConv) plain += 1;
    else if (isConv && !isPlain) converted += 1;
  }
  if (plain > converted) return "invoice_currency";
  if (converted > plain) return "inr";
  return "unknown";
}

// INR equivalents of the invoice's header amounts at `rate`. Amounts already in INR are left as they are.
export function convertToInr(e: StoredExtracted, basis: AmountBasis, rate: number): ForexConversion {
  const tax = num(e.cgst_amount) + num(e.sgst_amount) + num(e.igst_amount) + num(e.cess_amount);
  const has = e.taxable_amount !== null || e.total_amount !== null;
  if (basis === "unknown" || !has) return { basis, taxable_inr: null, tax_inr: null, total_inr: null, total_foreign: null };
  const inInr = basis === "inr";
  const toInr = (v: number | null) => (v === null ? null : round2(inInr ? v : v * rate));
  return {
    basis,
    taxable_inr: toInr(e.taxable_amount),
    tax_inr: round2(inInr ? tax : tax * rate),
    total_inr: toInr(e.total_amount),
    total_foreign: e.total_amount === null ? null : round2(inInr ? e.total_amount / rate : e.total_amount),
  };
}

const REASON_TEXT: Record<FxFailure, string> = {
  unsupported_currency: "the currency is not supported by the rate sources",
  bad_date: "the invoice date is not a valid date",
  future_date: "the invoice date is in the future",
  too_old: "the invoice date is too old for the rate sources",
  unavailable: "the rate sources could not be reached",
  implausible: "the rate sources returned a value that does not look right",
};

function fmtRate(r: number): string {
  return String(Math.round(r * 10000) / 10000);
}

export interface ForexOptions {
  tolerancePaise: number;
  deviationWarn?: number;
}

export async function resolveForex(extracted: StoredExtracted, items: StoredItem[], lookup: FxLookup, opts: ForexOptions): Promise<ForexResult> {
  const currency = (extracted.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || currency === "INR") return { exchangeRate: null, fieldMeta: null, flags: [], summary: null };

  const printed = hasRate(extracted.exchange_rate) && Math.abs(extracted.exchange_rate - 1) > 1e-9 ? extracted.exchange_rate : null;
  const base: ForexSummary = { currency, rate_origin: printed !== null ? "printed" : "none", rate: printed };
  const date = extracted.invoice_date;

  if (!date) {
    const flags: ReviewFlag[] = printed === null ? [{ code: "forex_rate_unavailable", severity: "info", field: "exchange_rate", message: "The invoice date was not read, so the exchange rate could not be looked up." }] : [];
    return { exchangeRate: null, fieldMeta: null, flags, summary: { ...base, lookup_failed: "bad_date" } };
  }

  const res = await lookup(currency, date);
  if (!res.ok) {
    const flags: ReviewFlag[] = printed === null
      ? [{ code: "forex_rate_unavailable", severity: "info", field: "exchange_rate", message: `No exchange rate is printed on the invoice and none could be fetched: ${REASON_TEXT[res.reason]}.`, details: { reason: res.reason, currency, date } }]
      : [];
    return { exchangeRate: null, fieldMeta: null, flags, summary: { ...base, requested_date: date, lookup_failed: res.reason } };
  }

  const ref: FxRate = res.rate;
  const refInfo = { reference_rate: ref.rate, rate_date: ref.rateDate, requested_date: date, source: ref.source, source_label: ref.sourceLabel };

  // The invoice's own rate: printed, or the one its lines agree on. Kept as it is, only cross-checked.
  const fromLines = printed === null ? impliedRate(items, true) : null;
  // A ratio of about 1 means the lines are still in the invoice currency (nothing was converted): that is not a rate.
  const own = printed ?? (fromLines !== null && hasRate(fromLines) && Math.abs(fromLines - 1) > 0.01 ? Math.round(fromLines * 1e6) / 1e6 : null);
  if (own !== null) {
    const origin: RateOrigin = printed !== null ? "printed" : "from_lines";
    const dev = Math.abs(own - ref.rate) / ref.rate;
    const flags: ReviewFlag[] = [];
    if (dev > (opts.deviationWarn ?? PRINTED_RATE_DEVIATION_WARN)) {
      flags.push({
        code: "forex_rate_differs_from_reference", severity: "warning", field: "exchange_rate",
        message: `The exchange rate ${printed !== null ? "on the invoice" : "used by the invoice lines"} (${fmtRate(own)}) differs by ${(dev * 100).toFixed(1)}% from the ${currency} rate of ${ref.rateDate} (${fmtRate(ref.rate)}). Check the rate on the original${printed !== null ? "; a digit may be misread" : ""}.`,
        details: { rate: own, rateOrigin: origin, reference: ref.rate, deviationPct: Math.round(dev * 10000) / 100, rateDate: ref.rateDate, source: ref.sourceLabel },
      });
    }
    const basis = detectBasis(items, own, opts.tolerancePaise, 0.0005);
    const conv = convertToInr(extracted, basis, own);
    if (printed === null) {
      flags.push({
        code: "forex_rate_from_lines", severity: "info", field: "exchange_rate",
        message: `No exchange rate is printed on the invoice. The item lines agree on ${currency} 1 = INR ${fmtRate(own)}, so that rate was used (${currency} rate of ${ref.rateDate}: ${fmtRate(ref.rate)}, ${(dev * 100).toFixed(1)}% apart).`,
        details: { rate: own, reference: ref.rate, rateDate: ref.rateDate, deviationPct: Math.round(dev * 10000) / 100, ...(conv.basis !== "unknown" ? { conversion: conv } : {}) },
      });
    }
    return {
      exchangeRate: printed === null ? own : null,
      fieldMeta: printed === null ? { state: "value", confidence: 1, source: "computed" } : null,
      flags,
      summary: { ...base, ...refInfo, rate: own, rate_origin: origin, deviation_pct: Math.round(dev * 10000) / 100, conversion: conv },
    };
  }

  // No printed rate and the lines do not agree on one: use the reference rate, marked as fetched.
  const basis = detectBasis(items, ref.rate, opts.tolerancePaise);
  const conv = convertToInr(extracted, basis, ref.rate);
  const sameDay = ref.rateDate === date;
  const totalText = conv.total_inr !== null && basis === "invoice_currency" && conv.total_foreign !== null
    ? ` Invoice total ${currency} ${conv.total_foreign.toFixed(2)} is about INR ${conv.total_inr.toFixed(2)}.`
    : "";
  const flag: ReviewFlag = {
    code: "forex_rate_auto_fetched", severity: "info", field: "exchange_rate",
    message: `No exchange rate is printed on the invoice. Used ${currency} 1 = INR ${fmtRate(ref.rate)} for ${ref.rateDate}${sameDay ? "" : " (the last working day before the invoice date)"} from ${ref.sourceLabel}. Confirm it matches the rate your books use.${totalText}`,
    details: { rate: ref.rate, rateDate: ref.rateDate, invoiceDate: date, source: ref.source, sourceLabel: ref.sourceLabel, tolerancePct: FETCHED_RATE_REL_TOLERANCE * 100, ...(conv.basis !== "unknown" ? { conversion: conv } : {}) },
  };
  return {
    exchangeRate: ref.rate,
    fieldMeta: { state: "value", confidence: 1, source: "fetched" },
    flags: [flag],
    summary: { ...base, ...refInfo, rate: ref.rate, rate_origin: "fetched", conversion: conv },
  };
}
