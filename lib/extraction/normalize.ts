// Turns validated model output into the shapes stored in the database.
// Normalization only trims text, upper-cases GSTINs and checks formats. It never changes an amount.
// Anything that cannot be stored safely becomes null with state "invalid" and a review flag.
import { HEADER_AMOUNT_FIELDS, HEADER_TEXT_FIELDS } from "./types.ts";
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

export function toPaise(amount: number): number {
  return Math.round(amount * 100);
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

// Used only to find duplicates: "INV-001", "inv/001" and "INV 001" are the same number.
export function normalizeInvoiceNumber(raw: string): string | null {
  const n = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n === "" ? null : n;
}

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
  opts: { dp: number; max: number; itemPosition?: number }
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
  if (v < 0) {
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
}

// Wording for a GSTIN whose check digit fails. "A character may have been misread" is only said when a
// misreading is actually possible; if two separate readings agree on all 15 characters the number is
// most likely printed that way on the invoice itself, so it is shown as information, not as a warning.
export function gstinChecksumFlagText(confirmedByRecheck: boolean): { severity: "info" | "warning"; message: string } {
  return confirmedByRecheck
    ? {
        severity: "info",
        message: "This GSTIN does not pass the standard check-digit test, but two readings of the document gave the same 15 characters, so it is most likely printed this way on the invoice.",
      }
    : { severity: "warning", message: "The GSTIN check digit does not match. A character may have been misread. Check the original." };
}

export interface NormalizeResult {
  extracted: StoredExtracted;
  items: StoredItem[];
}

export function normalizeExtraction(model: ModelOutput, opts: NormalizeOptions): NormalizeResult {
  const c: Collector = { flags: [], status: {} };
  const now = opts.now ?? new Date();

  const text: Record<string, string | null> = {};
  for (const key of HEADER_TEXT_FIELDS) text[key] = readText(c, key, model[key]);
  const amt: Record<string, number | null> = {};
  for (const key of HEADER_AMOUNT_FIELDS) amt[key] = readAmount(c, key, model[key], { dp: 2, max: MAX_ABS_AMOUNT });

  // Values that two separate readings agreed on are remembered, so later edits do not re-raise doubts about them.
  if (opts.agreed) {
    for (const key of opts.agreed) {
      const m = c.status[key];
      if (m && (m.state === "value" || m.state === "zero")) m.source = "recheck";
    }
  }

  // GSTINs: keep what was read (upper-case, no spaces); flag anything that is not a valid GSTIN.
  for (const key of ["supplier_gstin", "buyer_gstin"] as const) {
    const raw = text[key];
    if (raw === null) continue;
    const g = raw.replace(/\s+/g, "").toUpperCase();
    text[key] = g;
    const check = checkGstin(g);
    if (!check.ok) {
      const confirmed = check.reason === "checksum" && (opts.agreed?.has(key) ?? false);
      const text = check.reason === "format" ? { severity: "warning" as const, message: "This is not a valid GSTIN format. Check the original." } : gstinChecksumFlagText(confirmed);
      // An info-level note gets its own code, so the "GSTIN invalid" chip and filter (built from the code) stay quiet for it.
      c.flags.push({ code: text.severity === "info" ? "gstin_checksum_note" : "invalid_gstin", severity: text.severity, field: key, message: text.message, details: { reason: check.reason, ...(confirmed ? { confirmedByRecheck: true } : {}) } });
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
    const quantity = readAmount(ic, "quantity", mi.quantity, { dp: 3, max: MAX_ABS_QUANTITY, itemPosition: position });
    const unitPrice = readAmount(ic, "unit_price", mi.unit_price, { dp: 4, max: MAX_ABS_AMOUNT, itemPosition: position });
    const discount = readAmount(ic, "discount", mi.discount, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position });
    const taxable = readAmount(ic, "taxable_value", mi.taxable_value, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position });
    const taxAmount = readAmount(ic, "tax_amount", mi.tax_amount, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position });
    const lineTotal = readAmount(ic, "line_total", mi.line_total, { dp: 2, max: MAX_ABS_AMOUNT, itemPosition: position });

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
    taxable_amount: amt.taxable_value,
    discount_amount: amt.discount_total,
    cgst_amount: amt.cgst,
    sgst_amount: amt.sgst,
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
