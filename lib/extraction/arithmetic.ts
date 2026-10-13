// Invoice arithmetic: line items (INR and foreign currency) and the invoice totals.
// Checks only ADD flags. They never change a value.
//
// Calculation order used for every line (same as normal accounting practice):
//   1. gross   = quantity x unit price                       (in the invoice currency)
//   2. net     = gross - trade discount                      (in the invoice currency)
//                The discount can be a flat amount OR a percentage (5 can mean 5% or 5 USD). The extractor
//                does not say which, so every reading is tried (see lineCandidates) and the line passes if
//                any plausible reading reproduces the printed taxable value.
//   3. taxable = net x exchange rate                         (INR; rate = 1 for INR invoices)
//   4. tax     = taxable x GST %                             (checked in lib/review/gst.ts)
import { toPaise } from "./normalize.ts";
import type { ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

// Exchange rates are printed with 2 to 4 decimals, so a converted amount can be off by this fraction.
const RATE_REL_TOLERANCE = 0.0005;
// Lines whose taxable/net ratios agree this closely are treated as converted with one common rate.
const MAX_PLAUSIBLE_RATE = 1_000_000;

export interface ArithmeticContext {
  currency: string | null;
  exchangeRate: number | null | undefined;
  tolerancePaise: number;
}

function nz(v: number | null): number {
  return v ?? 0;
}

export function hasRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < MAX_PLAUSIBLE_RATE;
}

// True when amounts may have been converted: a non-INR currency, or a printed exchange rate that is not 1.
export function isForeign(currency: string | null, rate: number | null | undefined): boolean {
  if (currency !== null && currency !== undefined && currency.toUpperCase() !== "INR") return true;
  return hasRate(rate) && Math.abs(rate - 1) > 1e-9;
}

export interface LineSteps {
  gross: number;
  net: number;
  taxable: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type DiscountType = "PERCENT" | "AMOUNT" | "FLAT"; // FLAT and AMOUNT mean the same: a flat money amount

// Money maths is done on numbers rounded to 1e-6, so binary float noise (0.1 + 0.2) never decides a result.
function clean(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// net = gross - discount. With discountType "PERCENT" the discount is a percentage of gross; otherwise a flat amount.
export function lineSteps(quantity: number, unitPrice: number, discount: number | null, rate = 1, discountType: DiscountType = "AMOUNT"): LineSteps {
  const gross = clean(quantity * unitPrice);
  const d = nz(discount);
  const net = discountType === "PERCENT" ? clean(gross * (1 - d / 100)) : clean(gross - d);
  return { gross, net, taxable: clean(net * rate) };
}

export type Reading = "no_discount" | "flat" | "percent";
export interface Candidate {
  reading: Reading;
  net: number; // in the invoice currency
}

// Every net value (invoice currency) the line could legitimately have, one per reading of the discount.
//   - an explicit discountType is trusted: only that reading is used
//   - no discount, or discount 0: gross
//   - otherwise: the discount as printed may be a flat amount, a percentage (only when 0 < d <= 100), or ignored
//     (some invoices print a discount column that is already inside the unit price)
export function lineCandidates(it: Pick<StoredItem, "quantity" | "unit_price" | "discount_amount"> & { discount_type?: DiscountType | null }): Candidate[] {
  const q = it.quantity;
  const p = it.unit_price;
  if (q === null || p === null) return [];
  const gross = clean(q * p);
  const d = it.discount_amount;
  if (d === null || d === 0) return [{ reading: "no_discount", net: gross }];
  const out: Candidate[] = [];
  const type = it.discount_type ?? null;
  if (type !== "PERCENT") out.push({ reading: "flat", net: clean(gross - d) });
  if (type === "PERCENT" || (type === null && d > 0 && d <= 100)) out.push({ reading: "percent", net: clean(gross * (1 - d / 100)) });
  if (type === null) out.push({ reading: "no_discount", net: gross });
  return out;
}

// The conversion rate that most lines agree on, found from the lines themselves (taxable / net).
// Each line offers one candidate rate per discount reading; the rate supported by the most lines wins.
// If no two lines agree, fall back to the median of the plain (flat discount) ratios.
function impliedRate(items: StoredItem[]): number | null {
  const perLine: number[][] = [];
  const plain: number[] = [];
  for (const it of items) {
    if (it.taxable_amount === null || it.taxable_amount <= 0) continue;
    const cands = lineCandidates(it).filter((c) => c.net > 0);
    if (cands.length === 0) continue;
    perLine.push(cands.map((c) => it.taxable_amount! / c.net));
    plain.push(it.taxable_amount / cands[0].net);
  }
  if (perLine.length < 2) return null;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * RATE_REL_TOLERANCE;
  let best: { support: number; rates: number[] } | null = null;
  for (const r of perLine.flat()) {
    const matched = perLine.map((rs) => rs.find((x) => near(x, r))).filter((x): x is number => x !== undefined);
    if (!best || matched.length > best.support) best = { support: matched.length, rates: matched };
  }
  if (best && best.support >= 2) return median(best.rates);
  return median(plain);
}

export interface LineRateContext {
  tolerancePaise: number;
  foreign: boolean;
  explicitRate: number | null; // exchange rate printed on the invoice
  impliedRate: number | null; // rate found from the other lines
}

export type LineVerdict =
  | { status: "pass"; expectedPaise: number }
  | { status: "unverified" } // foreign currency but nothing to convert with
  | { status: "skipped" } // quantity, unit price or taxable value is missing
  | { status: "fail"; expectedPaise: number; flag: ReviewFlag };

// ONE line item: net = gross - discount (flat or %), taxable (INR) = net x exchange rate, compared with the printed
// taxable value (soft tolerance, default INR 1.00). Credit notes, returns and rebate rows may be negative: a line whose
// printed sign is opposite to quantity x price is also compared with the negated expectation.
export function validateLineItem(it: StoredItem, position: number, rc: LineRateContext): LineVerdict {
  const q = it.quantity;
  const p = it.unit_price;
  const t = it.taxable_amount;
  if (q === null || p === null || t === null) return { status: "skipped" };
  const tol = rc.tolerancePaise;
  const actual = toPaise(t);
  const disc = it.discount_amount;
  const cands = lineCandidates(it);
  const gross = clean(q * p);
  const within = (expectedPaise: number, relTol: number) => Math.abs(actual - expectedPaise) <= tol + Math.round(Math.abs(expectedPaise) * relTol);
  const flip = actual !== 0 && gross !== 0 && actual < 0 !== gross < 0; // a return / rebate printed with the opposite sign
  const withSign = (list: number[]) => (flip ? [...list, ...list.map((e) => -e)] : list);

  // Values exactly as printed in one currency: every reading of the discount, plus gross.
  const plain = [...cands.map((c) => toPaise(c.net)), toPaise(gross)];
  const plainOk = withSign(plain);
  if (plainOk.some((e) => within(e, 0))) return { status: "pass", expectedPaise: plain[0] };

  let rateUsed: number | null = null;
  if (rc.foreign) {
    const r = rc.explicitRate ?? rc.impliedRate;
    if (r === null) return { status: "unverified" };
    const converted = withSign([
      ...cands.map((c) => toPaise(c.net * r)), // discount (flat or %) in the invoice currency
      toPaise(gross * r),
      toPaise(gross * r - nz(disc)), // flat discount already in INR
    ]);
    if (converted.some((e) => within(e, RATE_REL_TOLERANCE))) return { status: "pass", expectedPaise: converted[0] };
    rateUsed = r;
  }

  // Reported "expected" uses the primary reading: the explicit type if known, else flat (the original behaviour).
  const net = (it.discount_type === "PERCENT" ? cands.find((c) => c.reading === "percent") : cands[0])?.net ?? gross;
  const expected = rateUsed === null ? plain[0] : toPaise(net * rateUsed);
  const flag: ReviewFlag = {
    code: "arithmetic_line_mismatch",
    severity: "warning",
    field: "taxable_value",
    itemPosition: position,
    message: rateUsed === null
      ? "Quantity x unit price does not match the item's taxable value."
      : `Quantity x unit price (less discount) x exchange rate ${Math.round(rateUsed * 10000) / 10000} does not match the item's taxable value.`,
    details: { expected: expected / 100, extracted: actual / 100, ...(rateUsed === null ? {} : { exchangeRate: rateUsed, rateSource: rc.explicitRate !== null ? "printed" : "from other lines" }) },
  };
  return { status: "fail", expectedPaise: expected, flag };
}

export function checkLineItems(items: StoredItem[], ctx: ArithmeticContext): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const foreign = isForeign(ctx.currency, ctx.exchangeRate);
  const explicitRate = foreign && hasRate(ctx.exchangeRate) ? ctx.exchangeRate : null;
  const rc: LineRateContext = {
    tolerancePaise: ctx.tolerancePaise,
    foreign,
    explicitRate,
    impliedRate: foreign && explicitRate === null ? impliedRate(items) : null,
  };
  let unverified = false;
  items.forEach((it, i) => {
    const v = validateLineItem(it, i + 1, rc);
    if (v.status === "unverified") unverified = true;
    else if (v.status === "fail") flags.push(v.flag);
  });
  if (unverified) {
    flags.push({
      code: "forex_rate_unverified",
      severity: "info",
      message: "Unit prices look like a foreign currency and no exchange rate was found, so quantity x unit price could not be checked against the taxable value.",
    });
  }
  return flags;
}

// Invoice totals: item taxable values -> header taxable value -> header taxes -> grand total.
export function checkTotals(extracted: StoredExtracted, items: StoredItem[], ctx: ArithmeticContext): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const tol = ctx.tolerancePaise;
  const fs = extracted.field_status;
  const foreignRate = isForeign(ctx.currency, ctx.exchangeRate) && hasRate(ctx.exchangeRate) ? ctx.exchangeRate : null;
  const itemsKnown = items.length > 0 && items.every((it) => it.taxable_amount !== null);
  const itemsSum = itemsKnown ? items.reduce((a, it) => a + toPaise(it.taxable_amount as number), 0) : null;

  const header = extracted.taxable_amount;
  if (header !== null && itemsSum !== null) {
    const candidates = [toPaise(header)];
    if (extracted.discount_amount !== null) candidates.push(toPaise(header) + toPaise(extracted.discount_amount));
    if (!candidates.some((cnd) => Math.abs(itemsSum - cnd) <= tol)) {
      flags.push({
        code: "arithmetic_subtotal_mismatch",
        severity: "error",
        field: "taxable_value",
        message: "The item taxable values do not add up to the invoice taxable value.",
        details: { itemsSum: itemsSum / 100, extracted: header / 100 },
      });
    }
  }

  // The invoice taxable value, or (when it was not read) the sum of the items.
  const base0 = header !== null ? toPaise(header) : itemsSum;
  const total = extracted.total_amount;
  if (total !== null && base0 !== null) {
    const taxes = [extracted.cgst_amount, extracted.sgst_amount, extracted.igst_amount, extracted.cess_amount];
    const taxPaise = taxes.reduce<number>((a, v) => a + (v === null ? 0 : toPaise(v)), 0);
    const base = base0 + taxPaise; // taxable + CGST + SGST + IGST + Cess
    const candidates = [{ value: base, rel: 0 }];
    if (extracted.discount_amount !== null) candidates.push({ value: base - toPaise(extracted.discount_amount), rel: 0 });
    // Grand total printed in the foreign currency while taxable and taxes are in INR.
    if (foreignRate !== null) candidates.push({ value: Math.round(base / foreignRate), rel: RATE_REL_TOLERANCE });
    const actual = toPaise(total);
    if (!candidates.some((c) => Math.abs(actual - c.value) <= tol + Math.round(Math.abs(c.value) * c.rel))) {
      const absent = (["cgst", "sgst", "igst", "cess"] as const).filter((k) => fs[k]?.state === "missing");
      flags.push({
        code: "arithmetic_total_mismatch",
        severity: "error",
        field: "grand_total",
        message: "Taxable value plus taxes does not equal the grand total.",
        details: { expected: base / 100, extracted: actual / 100, taxFieldsNotFound: absent, ...(header === null ? { taxableFromItems: true } : {}) },
      });
    }
  }
  return flags;
}
