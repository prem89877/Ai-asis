// Which verified-invoice fields go to which spreadsheet column, and how a row is built. No network, no secrets:
// this file is also used by the browser (column-mapping screen) and by the Tally exporter (duplicate key).
import { INVOICE_COLUMNS } from "../export/columns.ts";
import { normalizeInvoiceNumber } from "../extraction/invoice-number.ts";
import type { CellValue, ExportInvoice, InvoiceColumn } from "../export/columns.ts";

export interface MappingEntry { header: string; field: string | null } // field null = a column AI Asis leaves empty
export type DateFormat = "iso" | "dmy";
export type Guard = "none" | "excel";

// Fields that may be synced. Labels are the default header texts (taken from the export columns, so CSV, Excel and sheets agree).
const SYNC_KEYS = [
  "invoice_number", "invoice_date", "vendor_name", "vendor_gstin", "buyer_name", "buyer_gstin", "place_of_supply", "document_type", "currency",
  "taxable_amount", "discount_amount", "cgst_amount", "sgst_amount", "utgst_amount", "igst_amount", "cess_amount", "tax_total", "total_amount",
  "verified_at", "original_filename", "id",
] as const;
const COLUMN_BY_KEY = new Map<string, InvoiceColumn>(INVOICE_COLUMNS.map((c) => [c.key, c]));
export const SYNC_FIELDS: readonly { key: string; label: string }[] = SYNC_KEYS.map((k) => ({ key: k, label: COLUMN_BY_KEY.get(k)?.label ?? k }));
export const DEFAULT_SYNC_FIELDS: readonly string[] = [
  "invoice_number", "invoice_date", "vendor_name", "vendor_gstin", "buyer_name", "buyer_gstin", "place_of_supply",
  "taxable_amount", "cgst_amount", "sgst_amount", "utgst_amount", "igst_amount", "cess_amount", "total_amount", "verified_at", "id",
];
const FIELD_KEYS = new Set<string>(SYNC_KEYS);
const MAX_COLUMNS = 60;
const MAX_HEADER = 100;

// The AI Asis ID column is always present: it is how a lost response is recognised and how duplicates are found in the sheet.
export function defaultMapping(fields: string[]): MappingEntry[] {
  const keys = fields.filter((k, i) => FIELD_KEYS.has(k) && fields.indexOf(k) === i);
  if (!keys.includes("id")) keys.push("id");
  return keys.map((k) => ({ header: SYNC_FIELDS.find((f) => f.key === k)?.label ?? k, field: k }));
}

export type MappingCheck = { ok: true; mapping: MappingEntry[] } | { ok: false; message: string };

export function validateMapping(raw: unknown): MappingCheck {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: "Map at least one column." };
  if (raw.length > MAX_COLUMNS) return { ok: false, message: `Use at most ${MAX_COLUMNS} columns.` };
  const seen = new Set<string>();
  const out: MappingEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, message: "Invalid column mapping." };
    const { header, field } = item as { header?: unknown; field?: unknown };
    if (typeof header !== "string" || header.length > MAX_HEADER) return { ok: false, message: "Invalid column mapping." };
    if (field !== null && typeof field !== "string") return { ok: false, message: "Invalid column mapping." };
    if (field !== null) {
      if (!FIELD_KEYS.has(field)) return { ok: false, message: "Unknown field in the column mapping." };
      if (seen.has(field)) return { ok: false, message: "Each field can be mapped to one column only." };
      if (header.trim() === "") return { ok: false, message: "Every mapped column needs a header." };
      seen.add(field);
    }
    out.push({ header: header.trim(), field });
  }
  if (!seen.has("id")) return { ok: false, message: "Map the AI Asis ID column. It prevents duplicate rows." };
  return { ok: true, mapping: out };
}

const norm = (s: string) => s.trim().toLowerCase();

// True when the sheet's header row still matches the saved mapping (skipped columns are not compared).
export function headersMatch(mapping: MappingEntry[], actual: string[]): boolean {
  if (actual.length < mapping.length) return false;
  return mapping.every((m, i) => m.field === null || norm(m.header) === norm(String(actual[i] ?? "")));
}

// ---- cell values ----
const IST_MS = 330 * 60_000;
const p2 = (n: number) => String(n).padStart(2, "0");
function formatDate(iso: string, fmt: DateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? (fmt === "dmy" ? `${m[3]}/${m[2]}/${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`) : iso;
}
function formatDateTime(iso: string, fmt: DateFormat): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + IST_MS); // India time, so "verified on" matches the staff's clock
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return `${formatDate(date, fmt)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// Excel would turn "0012" into 12, "15/09/2026" into a date and "=..." into a formula. A leading apostrophe stores text.
// Google Sheets writes use RAW input, which keeps text as typed, so they need no guard.
export function excelTextGuard(value: string): string {
  if (value === "") return value;
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  if (/^0\d+$/.test(value) || /^\d{12,}$/.test(value)) return `'${value}`;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(\s\d{1,2}:\d{2})?$/.test(value)) return `'${value}`;
  return value;
}

function cell(col: InvoiceColumn, inv: ExportInvoice, fmt: DateFormat, guard: Guard): string | number {
  const v: CellValue = col.get(inv);
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return v;
  let text = v;
  if (col.kind === "date") text = formatDate(v, fmt);
  else if (col.kind === "datetime") text = formatDateTime(v, fmt);
  return guard === "excel" ? excelTextGuard(text) : text;
}

export function buildRow(inv: ExportInvoice, mapping: MappingEntry[], fmt: DateFormat, guard: Guard): (string | number)[] {
  return mapping.map((m) => {
    const col = m.field ? COLUMN_BY_KEY.get(m.field) : undefined;
    return col ? cell(col, inv, fmt, guard) : "";
  });
}

// ---- duplicate detection: the same supplier invoice uploaded twice ----
function financialYear(date: string | null): string {
  const m = date ? /^(\d{4})-(\d{2})/.exec(date) : null;
  if (!m) return "";
  const y = Number(m[1]);
  const start = Number(m[2]) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
// Supplier + invoice number + Indian financial year. null = no number, no key.
//  * The number goes through the SAME normalizer as the database duplicate check (normalizeInvoiceNumber).
//  * The supplier is identified by NAME first and by GSTIN only when there is no name. A misread GSTIN (one wrong character) used to
//    give the same invoice a different key, so the duplicate was missed. The trade-off: two different suppliers whose normalized
//    names are identical and who print the same invoice number in the same year would be treated as one. Review shows both anyway.
export function dedupeKey(inv: Pick<ExportInvoice, "vendor_name" | "vendor_gstin" | "invoice_number" | "invoice_date">): string | null {
  const number = normalizeInvoiceNumber(inv.invoice_number ?? "");
  if (!number) return null;
  const gstin = (inv.vendor_gstin ?? "").replace(/\s+/g, "").toUpperCase();
  const name = (inv.vendor_name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${name || gstin}|${number}|${financialYear(inv.invoice_date)}`.slice(0, 300);
}

// ---- spreadsheet links and A1 notation ----
const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
export function parseSpreadsheetId(input: string): string | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  if (SHEET_ID.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
    const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
export function colLetters(index: number): string {
  let n = index + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function quoteSheet(name: string): string { return `'${name.replace(/'/g, "''")}'`; }
