// Turns validated model output into the shapes stored in the database.
// Normalization only trims text, upper-cases GSTINs and checks formats. It never changes an amount.
// Anything that cannot be stored safely becomes null with state "invalid" and a review flag.
import { suggestGstinFixes, suggestionText } from "./gstin.ts";
import { cleanIdentifier } from "./identifiers.ts";
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS } from "./types.ts";
import type { StoredItem as StoredItemType } from "./types.ts";
import type {
  FieldMeta,
  FieldState,
  ModelField,
  ModelOutput,
  ReviewFlag,
  StoredExtracted,
  StoredItem,
} from "./types.ts";

export const MAX_ABS_AMOUNT = 999_999_999_999.99; // numeric(14,2)
export const MAX_ABS_QUANTITY = 99_999_999_999.999; // numeric(14,3)
const GST_START = "2017-07-01";

// The ONE rupees -> paise conversion (tax-components.ts and tally/build.ts use it too). Rounds half away from zero on the DECIMAL
// value, so 1.005 -> 101 and 0.285 -> 29 (plain Math.round(x * 100) gives 100 and 28 because of binary float error) and a credit
// note rounds exactly like its positive twin (-0.025 -> -3, not -2). A non-finite amount is a bug upstream, so it throws instead of
// letting NaN / Infinity slip silently through every later comparison.
export function toPaise(amount: number): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) throw new RangeError("toPaise: amount must be a finite number");
  const abs = Math.abs(amount);
  const decimal = Math.round(Number(`${abs}e2`)); // "1.005e2" = 100.5 exactly; NaN when the text already has an exponent
  const paise = Number.isNaN(decimal) ? Math.round(abs * 100) : decimal;
  return amount < 0 && paise !== 0 ? -paise : paise;
}

// ---- GSTIN -----------------------------------------------------------------------------------

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function gstinChecksumChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const idx = GSTIN_CHARS.indexOf(first14[i]);
    if (idx < 0) return null;
    const product = idx * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck = { ok: true } | { ok: false; reason: "format" | "checksum" };

export function checkGstin(gstin: string): GstinCheck {
  if (!GSTIN_RE.test(gstin)) return { ok: false, reason: "format" };
  return gstinChecksumChar(gstin.slice(0, 14)) === gstin[14] ? { ok: true } : { ok: false, reason: "checksum" };
}

// ---- Small normalizers ---------------------------------------------------------------------------

export function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeIsoDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Matches line_items.hsn_code (4 to 8 digits).
export function normalizeHsn(raw: string): string | null {
  const digits = raw.replace(/[\s.\-]/g, "");
  return /^[0-9]{4,8}$/.test(digits) ? digits : null;
}

// Used only to find duplicates. Defined in invoice-number.ts so the Tally export and the sheet sync use the very same rule.
export { normalizeInvoiceNumber } from "./invoice-number.ts";
import { normalizeInvoiceNumber } from "./invoice-number.ts";

export function nameKey(raw: string | null): string | null {
  if (!raw) return null;
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n === "" ? null : n;
}

function decimalsExceed(v: number, dp: number): boolean {
  const scaled = v * 10 ** dp;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6 * Math.max(1, Math.abs(scaled));
}

// ---- Collector -----------------------------------------------------------------------------------

interface Collector {
  flags: ReviewFlag[];
  status: Record<string, FieldMeta>;
}

function meta(f: ModelField<unknown>, state: FieldState): FieldMeta {
  return { state, confidence: Math.round(f.confidence * 1000) / 1000 };
}

function readText(c: Collector, key: string, f: ModelField<string>): string | null {
  if (f.status !== "present") {
    c.status[key] = meta(f, f.status);
    return null;
  }
  const v = cleanText(f.value as string);
  c.status[key] = meta(f, "value");
  return v;
}

function readAmount(
  c: Collector,
  key: string,
  f: ModelField<number>,
  opts: { dp: number; max: number; itemPosition?: number; allowNegative?: boolean }
): number | null {
  const base = opts.itemPosition ? { itemPosition: opts.itemPosition } : {};
  if (f.status !== "present") {
    c.status[key] = meta(f, f.status);
    return null;
  }
  const v = f.value as number;
  if (Math.abs(v) > opts.max) {
    c.status[key] = meta(f, "invalid");
    c.flags.push({ code: "amount_out_of_range", severity: "error", field: key, ...base, message: "The value is outside the range that can be stored, so it was not saved." });
    return null;
  }
  c.status[key] = meta(f, v === 0 ? "zero" : "value");
  if (v < 0 && !opts.allowNegative) {
    c.flags.push({ code: "negative_amount", severity: "warning", field: key, ...base, message: "A negative number was extracted. Check the original." });
  }
  if (decimalsExceed(v, opts.dp)) {
    c.flags.push({ code: "amount_precision", severity: "warning", field: key, ...base, message: `More than ${opts.dp} decimal places were extracted; the stored value is rounded to ${opts.dp}.` });
  }
  return v;
}

// ---- Main ----------------------------------------------------------------------------------------

export interface NormalizeOptions {
  model: string;
  now?: Date;
  // Header fields (model names, e.g. "supplier_gstin") where two separate readings of the document gave
  // the same value. Such a value is stored with source "recheck".
  agreed?: ReadonlySet<string>;
  // Kept only so older callers still compile. A GSTIN is never replaced by normalization, whatever this says.
  gstinAutoCorrect?: boolean;
}

// Model confidence above which two agreeing readings of a failing GSTIN are treated as a print error.
export const GSTIN_PRINT_ERROR_CONFIDENCE = 0.95;

// Wording for a GSTIN whose check digit fails. "A character may have been misread" is only said when a
// misreading is actually possible. If two separate readings agree on all 15 characters with high confidence the
// number is most likely printed that way on the invoice itself, so it is shown as information, not a warning.
export function gstinChecksumFlagText(printError: boolean): { severity: "info" | "warning"; message: string } {
  return printError
    ? {
        severity: "info",
        message: "GSTIN Checksum Mismatch (Possible Print Error). Two readings of the document gave the same 15 characters with high confidence, so it is most likely printed this way on the invoice.",
      }
    : { severity: "warning", message: "The GSTIN check digit does not match. A character may have been misread. Check the original." };
}

export interface NormalizeResult {
  extracted: StoredExtracted;
  items: StoredItem[];
}

function currencyEarly(raw: string | null): string | null {
  return raw !== null && /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : null;
}

// "PERCENT" / "%" -> PERCENT; "FLAT" / "AMOUNT" / "VALUE" -> FLAT. Anything else is dropped (the arithmetic then tries both readings).
export function normalizeDiscountType(raw: string | null): "PERCENT" | "FLAT" | null {
  if (raw === null) return null;
  const t = raw.trim().toUpperCase();
  if (/^(PERCENT|PERCENTAGE|PCT|%)$/.test(t)) return "PERCENT";
  if (/^(FLAT|AMOUNT|VALUE|FIXED|ABSOLUTE)$/.test(t)) return "FLAT";
  return null;
}

// "IGST" -> IGST; "CGST_SGST", "CGST+SGST", "CGST/SGST", "CGST & SGST", "SGST/UTGST" -> CGST_SGST; "CGST+UTGST" -> CGST_UTGST; "NONE", "NIL", "EXEMPT" -> NONE.
export function normalizeAppliedTaxType(raw: string | null): StoredItemType["applied_tax_type"] {
  if (raw === null) return null;
  const t = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (t === "IGST") return "IGST";
  // Any label that names CGST together with SGST or UTGST ("CGST+SGST/UTGST", "CGST & UTGST", "UTGST/CGST") is the split tax.
  // CGST with UTGST only (a Union Territory supply) is its own type, so UTGST is never folded into SGST. Labels that name
  // both SGST and UTGST ("SGST/UTGST") stay CGST_SGST for older readings.
  const hasUt = t.replace(/UTGST/g, "").length !== t.length, hasSgstOnly = t.replace(/UTGST/g, "").includes("SGST");
  if (t.includes("CGST") && hasUt && !hasSgstOnly && !t.includes("IGST")) return "CGST_UTGST";
  if (t.includes("CGST") && (t.includes("SGST") || t.includes("UTGST")) && !t.includes("IGST")) return "CGST_SGST";
  if (/^(NONE|NIL|EXEMPT|NILRATED|ZERO)$/.test(t)) return "NONE";
  return null;
}

export function normalizeExtraction(model: ModelOutput, opts: NormalizeOptions): NormalizeResult {
  const c: Collector = { flags: [], status: {} };
  const now = opts.now ?? new Date();

  const text: Record<string, string | null> = {};
  for (const key of HEADER_TEXT_FIELDS) text[key] = readText(c, key, model[key]);
  const amt: Record<string, number | null> = {};
  // Credit / debit notes (and returns, rebates) may legitimately print negative amounts: no negative-value warning there.
  const memo = model.document_type === "credit_note" || model.document_type === "debit_note";
  for (const key of HEADER_AMOUNT_FIELDS) amt[key] = readAmount(c, key, model[key], { dp: 2, max: MAX_ABS_AMOUNT, allowNegative: memo });

  // Values that two separate readings agreed on are remembered, so later edits do not re-raise doubts about them.
  if (opts.agreed) {
    for (const key of opts.agreed) {
      const m = c.status[key];
      if (m && (m.state === "value" || m.state === "zero")) m.source = "recheck";
    }
  }

  // Exchange rate (optional field): INR per 1 unit of the invoice currency. Must be positive to be usable.
  let exchangeRate: number | null = null;
  if (model.exchange_rate) {
    exchangeRate = readAmount(c, "exchange_rate", model.exchange_rate, { dp: 6, max: 1e6 });
    if (exchangeRate !== null && exchangeRate <= 0) {
      c.status.exchange_rate = { ...c.status.exchange_rate, state: "invalid" };
      c.flags.push({ code: "invalid_exchange_rate", severity: "warning", field: "exchange_rate", message: "The exchange rate is not a positive number, so it was not used. Check the original." });
      exchangeRate = null;
    }
  }

  // Optional extras: TCS (Sec 206C), TDS (Sec 194Q), pre-tax charges (freight, handling, transit insurance, packaging), round-off,
  // net payable (amount after the TDS deduction).
  // Round-off may be negative; the others are normally positive. Absent stays null, it is never turned into 0.
  const extras: Record<string, number | null> = {};
  for (const key of ["utgst_amount", "tcs_amount", "tds_amount", "pre_tax_charges", "round_off_amount", "net_payable_amount"] as const) {
    const f = model[key];
    extras[key] = f ? readAmount(c, key, f, { dp: 2, max: MAX_ABS_AMOUNT, allowNegative: memo || key === "round_off_amount" }) : null;
    // UTGST is an editable header field like SGST: a reading that did not mention it records "missing" instead of nothing.
    if (!f && key === "utgst_amount") c.status[key] = { state: "missing", confidence: 0 };
  }
  // e-invoice / e-way bill metadata: text only, never used in any calculation. Labels ("IRN:"), spaces, line breaks and dashes are
  // removed; a misread letter inside an IRN (O for 0, I or l for 1) is repaired only when that gives exactly 64 hex characters,
  // and the repair is reported. A value that is still wrong is kept as read and flagged by the validation engine.
  const meta2: Record<string, string | null> = {};
  for (const key of ["irn", "ack_no", "eway_bill_no"] as const) {
    const f = model[key];
    const v = f ? readText(c, key, f) : null;
    if (v === null) {
      meta2[key] = null;
      continue;
    }
    const cleaned = cleanIdentifier(key, v);
    meta2[key] = cleaned.value;
    if (cleaned.repaired) {
      c.flags.push({
        code: "irn_lookalike_repaired", severity: "info", field: key,
        message: "Letters that cannot be part of an IRN were read as digits (O as 0, I or l as 1). Compare the IRN with the QR code or the original.",
        details: { original: cleaned.repaired.from, repaired: cleaned.repaired.to },
      });
    }
  }
  // INR invoices carry exchange rate 1.0 by default. A foreign currency without a printed rate stays null: never guessed.
  if (exchangeRate === null && (currencyEarly(text.currency) === "INR")) exchangeRate = 1;

  // GSTINs: keep what was read (upper-case, no spaces); flag anything that is not a valid GSTIN.
  for (const key of ["supplier_gstin", "buyer_gstin"] as const) {
    const raw = text[key];
    if (raw === null) continue;
    const g = raw.replace(/\s+/g, "").toUpperCase();
    text[key] = g;
    const check = checkGstin(g);
    // The raw reading is kept as the saved value and also recorded on its own, so no later step can lose it. A failing GSTIN is
    // never replaced here: a check digit that fails may be printed that way on the invoice. Possible corrections are only
    // listed in the flag (details.suggestions); they are applied only when a reviewer types them or a source re-read proves them.
    c.status[key] = { ...c.status[key], rawValue: g, gstinCheck: check.ok ? "valid" : check.reason === "checksum" ? "checksum_failed" : "format_invalid" };
    if (!check.ok) {
      const confirmed = check.reason === "checksum" && (opts.agreed?.has(key) ?? false) && model[key].confidence > GSTIN_PRINT_ERROR_CONFIDENCE;
      const text = check.reason === "format" ? { severity: "warning" as const, message: "This is not a valid GSTIN format. Check the original." } : gstinChecksumFlagText(confirmed);
      const suggestions = suggestGstinFixes(g);
      // An info-level note gets its own code, so the "GSTIN invalid" chip and filter (built from the code) stay quiet for it.
      c.flags.push({
        code: text.severity === "info" ? "gstin_checksum_note" : "invalid_gstin",
        severity: text.severity,
        field: key,
        message: text.message + suggestionText(suggestions),
        details: { reason: check.reason, ...(confirmed ? { confirmedByRecheck: true } : {}), ...(suggestions.length ? { suggestions } : {}) },
      });
    }
  }

  // Date
  let invoiceDate: string | null = null;
  if (text.invoice_date !== null) {
    invoiceDate = normalizeIsoDate(text.invoice_date);
    if (invoiceDate === null) {
      c.status.invoice_date = { ...c.status.invoice_date, state: "invalid" };
      c.flags.push({ code: "invalid_date", severity: "error", field: "invoice_date", message: "The invoice date is not a valid date, so it was not saved." });
    } else {
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
      if (invoiceDate < GST_START || invoiceDate > tomorrow) {
        c.flags.push({ code: "implausible_date", severity: "warning", field: "invoice_date", message: "The invoice date is before GST started or in the future. Check the original." });
      }
    }
  }

  // Currency
  let currency: string | null = null;
  if (text.currency !== null) {
    if (/^[A-Za-z]{3}$/.test(text.currency)) {
      currency = text.currency.toUpperCase();
    } else {
      c.status.currency = { ...c.status.currency, state: "invalid" };
      c.flags.push({ code: "invalid_currency", severity: "warning", field: "currency", message: "The currency is not a 3-letter code, so it was not saved." });
    }
  }

  // Items
  const items: StoredItem[] = model.line_items.map((mi, idx) => {
    const position = idx + 1;
    const ic: Collector = { flags: c.flags, status: {} };
    const desc = readText(ic, "description", mi.description);
    const unit = readText(ic, "unit", mi.unit);
    const hsnRaw = readText(ic, "hsn_sac", mi.hsn_sac);
    let hsn: string | null = null;
    if (hsnRaw !== null) {
      hsn = normalizeHsn(hsnRaw);
      if (hsn === null) {
        ic.status.hsn_sac = { ...ic.status.hsn_sac, state: "invalid" };
        c.flags.push({ code: "invalid_hsn", severity: "info", field: "hsn_sac", itemPosition: position, message: "The HSN/SAC is not 4 to 8 digits, so it was not saved." });
      }
    }
    // Returns, rebates and trade-volume discounts print negative lines: allowed here. Whether a negative line is believable
    // (signs agree, item total still ties to the invoice) is judged once per invoice in gst-engine.ts (validateNegativeLines).
    const neg = { allowNegative: true };
    const quantity = readAmount(ic, "quantity", mi.quantity, { dp: 3, max: MAX_ABS_QUANTITY, itemPosition: position, ...neg });
    const unitPrice = readAmount(ic, "unit_price", mi.unit_price, { dp: 4, max: MAX_ABS_AMOUNT, itemPosition: position, ...neg });
    const discount = readAmount(ic, "discount", mi.discount, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position, ...neg });
    const taxable = readAmount(ic, "taxable_value", mi.taxable_value, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position, ...neg });
    const taxAmount = readAmount(ic, "tax_amount", mi.tax_amount, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position, ...neg });
    const lineTotal = readAmount(ic, "line_total", mi.line_total, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position, ...neg });
    const discountType = mi.discount_type ? normalizeDiscountType(readText(ic, "discount_type", mi.discount_type)) : null;
    const appliedTax = mi.applied_tax_type ? normalizeAppliedTaxType(readText(ic, "applied_tax_type", mi.applied_tax_type)) : null;

    let rate = readAmount(ic, "gst_rate", mi.gst_rate, { dp: 2, max: 1e6, itemPosition: position });
    if (rate !== null && (rate < 0 || rate > 100)) {
      ic.status.gst_rate = { ...ic.status.gst_rate, state: "invalid" };
      c.flags.push({ code: "invalid_gst_rate", severity: "warning", field: "gst_rate", itemPosition: position, message: "The GST rate is outside 0 to 100, so it was not saved." });
      rate = null;
    }
    return {
      description: desc,
      hsn_code: hsn,
      quantity,
      unit,
      unit_price: unitPrice,
      discount_amount: discount,
      discount_type: discountType,
      applied_tax_type: appliedTax,
      taxable_amount: taxable,
      gst_rate: rate,
      gst_amount: taxAmount,
      line_total: lineTotal,
      field_status: ic.status,
    };
  });

  // Overall confidence = mean of the model's own confidence for header fields it could read.
  // It is the model's self-report, not a measured accuracy.
  const confs = [...HEADER_TEXT_FIELDS, ...HEADER_AMOUNT_FIELDS]
    .filter((k) => model[k].status === "present")
    .map((k) => model[k].confidence);
  const confidence = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : null;

  const extracted: StoredExtracted = {
    vendor_name: text.supplier_name,
    buyer_name: text.buyer_name,
    vendor_gstin: text.supplier_gstin,
    buyer_gstin: text.buyer_gstin,
    invoice_number: text.invoice_number,
    invoice_number_norm: text.invoice_number ? normalizeInvoiceNumber(text.invoice_number) : null,
    invoice_date: invoiceDate,
    place_of_supply: text.place_of_supply,
    currency,
    exchange_rate: exchangeRate,
    tcs_amount: extras.tcs_amount,
    tds_amount: extras.tds_amount,
    pre_tax_charges: extras.pre_tax_charges,
    round_off_amount: extras.round_off_amount,
    net_payable_amount: extras.net_payable_amount,
    irn: meta2.irn,
    ack_no: meta2.ack_no,
    eway_bill_no: meta2.eway_bill_no,
    gstin_auto_corrected: ["supplier_gstin", "buyer_gstin"].some((k) => c.status[k]?.autoCorrected !== undefined),
    taxable_amount: amt.taxable_value,
    discount_amount: amt.discount_total,
    cgst_amount: amt.cgst,
    sgst_amount: amt.sgst,
    utgst_amount: extras.utgst_amount,
    igst_amount: amt.igst,
    cess_amount: amt.cess,
    total_amount: amt.grand_total,
    confidence,
    document_type: model.document_type,
    field_status: c.status,
    review_flags: c.flags,
    raw_extraction: model,
    extraction_model: opts.model,
  };
  return { extracted, items };
}
