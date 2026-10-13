// Invoice arithmetic: line items (INR and foreign currency) and the invoice totals.
// Checks only ADD flags. They never change a value.
//
// Calculation order used for every line (same as normal accounting practice):
//   1. gross   = quantity x unit price                       (in the invoice currency)
//   2. net     = gross - trade discount                      (in the invoice currency)
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

export function lineSteps(quantity: number, unitPrice: number, discount: number | null, rate = 1): LineSteps {
  const gross = quantity * unitPrice;
  const net = gross - nz(discount);
  return { gross, net, taxable: net * rate };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The conversion rate that most lines agree on, found from the lines themselves (taxable / net).
function impliedRate(items: StoredItem[]): number | null {
  const ratios: number[] = [];
  for (const it of items) {
    if (it.quantity === null || it.unit_price === null || it.taxable_amount === null) continue;
    const { net } = lineSteps(it.quantity, it.unit_price, it.discount_amount);
    if (net > 0 && it.taxable_amount > 0) ratios.push(it.taxable_amount / net);
  }
  return ratios.length >= 2 ? median(ratios) : null;
}

export function checkLineItems(items: StoredItem[], ctx: ArithmeticContext): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const tol = ctx.tolerancePaise;
  const foreign = isForeign(ctx.currency, ctx.exchangeRate);
  const explicit = foreign && hasRate(ctx.exchangeRate) ? ctx.exchangeRate : null;
  const implied = foreign && explicit === null ? impliedRate(items) : null;
  let unverified = false;

  items.forEach((it, i) => {
    const q = it.quantity;
    const p = it.unit_price;
    const t = it.taxable_amount;
    if (q === null || p === null || t === null) return;
    const actual = toPaise(t);
    const disc = it.discount_amount;
    const { gross, net } = lineSteps(q, p, disc);

    // Values exactly as printed in one currency: with or without the item discount applied.
    const plain = [toPaise(net), toPaise(gross)];
    const within = (expectedPaise: number, relTol: number) => Math.abs(actual - expectedPaise) <= tol + Math.round(Math.abs(expectedPaise) * relTol);
    if (plain.some((e) => within(e, 0))) return;

    let rateUsed: number | null = null;
    if (foreign) {
      const r = explicit ?? implied;
      if (r === null) {
        unverified = true; // foreign currency, but nothing to convert with
        return;
      }
      const converted = [toPaise(net * r), toPaise(gross * r), toPaise(gross * r - nz(disc))]; // discount in foreign currency, or already in INR
      if (converted.some((e) => within(e, RATE_REL_TOLERANCE))) return;
      rateUsed = r;
    }

    const expected = rateUsed === null ? plain[0] : toPaise(net * rateUsed);
    flags.push({
      code: "arithmetic_line_mismatch",
      severity: "warning",
      field: "taxable_value",
      itemPosition: i + 1,
      message: rateUsed === null
        ? "Quantity x unit price does not match the item's taxable value."
        : `Quantity x unit price (less discount) x exchange rate ${Math.round(rateUsed * 10000) / 10000} does not match the item's taxable value.`,
      details: { expected: expected / 100, extracted: actual / 100, ...(rateUsed === null ? {} : { exchangeRate: rateUsed, rateSource: explicit !== null ? "printed" : "from other lines" }) },
    });
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
