// Column registry for exports. Users pick and order columns by key; the server only accepts keys listed here.
// Adding a column = adding one entry. GST amounts are always separate columns (CGST, SGST, IGST, Cess).
import { DOCUMENT_TYPE_LABEL } from "../review/fields.ts";
import { reviewState, REVIEW_STATE_LABEL } from "../review/status.ts";

export type CellValue = string | number | null;
export type ColumnKind = "text" | "date" | "datetime" | "money" | "qty" | "price" | "rate" | "integer";

export interface ExportFlag {
  code: string;
  severity: string;
  message: string;
  itemPosition?: number;
}

export interface ExportInvoice {
  id: string;
  original_filename: string;
  status: string;
  created_at: string;
  vendor_name: string | null;
  vendor_gstin: string | null;
  buyer_name: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  place_of_supply: string | null;
  currency: string | null;
  document_type: string | null;
  taxable_amount: number | null;
  discount_amount: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  cess_amount: number | null;
  tax_total: number | null;
  total_amount: number | null;
  confidence: number | null;
  review_flags: ExportFlag[] | null;
  verified_at: string | null;
}

export interface ExportItem {
  invoice_id: string;
  position: number;
  description: string | null;
  hsn_code: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_amount: number | null;
  taxable_amount: number | null;
  gst_rate: number | null;
  gst_amount: number | null;
  line_total: number | null;
}

export interface InvoiceColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  width: number;
  group: "Invoice" | "Parties" | "GST and totals" | "Review" | "Source";
  get(inv: ExportInvoice): CellValue;
}

export interface ItemColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  width: number;
  /** Invoice reference columns repeat the parent invoice on every item row. */
  reference: boolean;
  get(item: ExportItem, inv: ExportInvoice): CellValue;
}

const MAX_FLAG_TEXT = 2000;

export function flagsSummary(flags: ExportFlag[] | null): string | null {
  if (!flags || flags.length === 0) return null;
  const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const text = [...flags]
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
    .map((f) => `[${f.severity}] ${f.itemPosition ? `Item ${f.itemPosition}: ` : ""}${f.message}`)
    .join(" | ");
  return text.length > MAX_FLAG_TEXT ? `${text.slice(0, MAX_FLAG_TEXT - 1)}…` : text;
}

export const INVOICE_COLUMNS: readonly InvoiceColumn[] = [
  { key: "invoice_number", label: "Invoice No", kind: "text", width: 18, group: "Invoice", get: (i) => i.invoice_number },
  { key: "invoice_date", label: "Invoice Date", kind: "date", width: 14, group: "Invoice", get: (i) => i.invoice_date },
  { key: "document_type", label: "Document Type", kind: "text", width: 16, group: "Invoice", get: (i) => (i.document_type ? DOCUMENT_TYPE_LABEL[i.document_type] ?? i.document_type : null) },
  { key: "currency", label: "Currency", kind: "text", width: 10, group: "Invoice", get: (i) => i.currency },
  { key: "vendor_name", label: "Supplier Name", kind: "text", width: 30, group: "Parties", get: (i) => i.vendor_name },
  { key: "vendor_gstin", label: "Supplier GSTIN", kind: "text", width: 18, group: "Parties", get: (i) => i.vendor_gstin },
  { key: "buyer_name", label: "Buyer Name", kind: "text", width: 30, group: "Parties", get: (i) => i.buyer_name },
  { key: "buyer_gstin", label: "Buyer GSTIN", kind: "text", width: 18, group: "Parties", get: (i) => i.buyer_gstin },
  { key: "place_of_supply", label: "Place of Supply", kind: "text", width: 22, group: "Parties", get: (i) => i.place_of_supply },
  { key: "taxable_amount", label: "Taxable Value", kind: "money", width: 16, group: "GST and totals", get: (i) => i.taxable_amount },
  { key: "discount_amount", label: "Discount", kind: "money", width: 14, group: "GST and totals", get: (i) => i.discount_amount },
  { key: "cgst_amount", label: "CGST", kind: "money", width: 14, group: "GST and totals", get: (i) => i.cgst_amount },
  { key: "sgst_amount", label: "SGST/UTGST", kind: "money", width: 14, group: "GST and totals", get: (i) => i.sgst_amount },
  { key: "igst_amount", label: "IGST", kind: "money", width: 14, group: "GST and totals", get: (i) => i.igst_amount },
  { key: "cess_amount", label: "Cess", kind: "money", width: 12, group: "GST and totals", get: (i) => i.cess_amount },
  { key: "tax_total", label: "Total Tax", kind: "money", width: 14, group: "GST and totals", get: (i) => i.tax_total },
  { key: "total_amount", label: "Invoice Total", kind: "money", width: 16, group: "GST and totals", get: (i) => i.total_amount },
  { key: "status", label: "Review Status", kind: "text", width: 16, group: "Review", get: (i) => REVIEW_STATE_LABEL[reviewState(i.status)] },
  { key: "verified_at", label: "Verified On", kind: "datetime", width: 18, group: "Review", get: (i) => i.verified_at },
  { key: "flag_count", label: "Open Flags", kind: "integer", width: 11, group: "Review", get: (i) => (i.review_flags ? i.review_flags.length : null) },
  { key: "flags_summary", label: "Review Flags", kind: "text", width: 60, group: "Review", get: (i) => flagsSummary(i.review_flags) },
  { key: "confidence", label: "Model Confidence %", kind: "integer", width: 12, group: "Review", get: (i) => (i.confidence === null ? null : Math.round(Number(i.confidence) * 100)) },
  { key: "original_filename", label: "Source File", kind: "text", width: 30, group: "Source", get: (i) => i.original_filename },
  { key: "created_at", label: "Uploaded On", kind: "datetime", width: 18, group: "Source", get: (i) => i.created_at },
  { key: "id", label: "AI Asis ID", kind: "text", width: 38, group: "Source", get: (i) => i.id },
];

export const ITEM_COLUMNS: readonly ItemColumn[] = [
  { key: "inv_invoice_number", label: "Invoice No", kind: "text", width: 18, reference: true, get: (_i, inv) => inv.invoice_number },
  { key: "inv_invoice_date", label: "Invoice Date", kind: "date", width: 14, reference: true, get: (_i, inv) => inv.invoice_date },
  { key: "inv_vendor_name", label: "Supplier Name", kind: "text", width: 30, reference: true, get: (_i, inv) => inv.vendor_name },
  { key: "inv_vendor_gstin", label: "Supplier GSTIN", kind: "text", width: 18, reference: true, get: (_i, inv) => inv.vendor_gstin },
  { key: "inv_id", label: "AI Asis ID", kind: "text", width: 38, reference: true, get: (_i, inv) => inv.id },
  { key: "position", label: "Item No", kind: "integer", width: 9, reference: false, get: (it) => it.position },
  { key: "description", label: "Description", kind: "text", width: 40, reference: false, get: (it) => it.description },
  { key: "hsn_code", label: "HSN/SAC", kind: "text", width: 12, reference: false, get: (it) => it.hsn_code },
  { key: "quantity", label: "Quantity", kind: "qty", width: 12, reference: false, get: (it) => it.quantity },
  { key: "unit", label: "Unit", kind: "text", width: 10, reference: false, get: (it) => it.unit },
  { key: "unit_price", label: "Unit Price", kind: "price", width: 14, reference: false, get: (it) => it.unit_price },
  { key: "discount_amount", label: "Item Discount", kind: "money", width: 14, reference: false, get: (it) => it.discount_amount },
  { key: "taxable_amount", label: "Item Taxable Value", kind: "money", width: 16, reference: false, get: (it) => it.taxable_amount },
  { key: "gst_rate", label: "GST Rate %", kind: "rate", width: 11, reference: false, get: (it) => it.gst_rate },
  { key: "gst_amount", label: "Item GST Amount", kind: "money", width: 16, reference: false, get: (it) => it.gst_amount },
  { key: "line_total", label: "Item Total", kind: "money", width: 14, reference: false, get: (it) => it.line_total },
];

// Defaults for a first export.
export const DEFAULT_COLUMNS: readonly string[] = [
  "invoice_number", "invoice_date", "vendor_name", "vendor_gstin", "buyer_gstin", "place_of_supply",
  "taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "cess_amount", "total_amount", "status", "flags_summary",
];
export const DEFAULT_ITEM_COLUMNS: readonly string[] = [
  "inv_invoice_number", "inv_vendor_name", "position", "description", "hsn_code", "quantity", "unit", "unit_price",
  "taxable_amount", "gst_rate", "gst_amount", "line_total",
];

export const MAX_COLUMNS = 40;

export type ColumnCheck = { ok: true; keys: string[] } | { ok: false; message: string };

// Keeps the caller's order. Unknown or repeated keys are rejected, not dropped, so a typo is never silent.
export function validateColumnKeys(raw: unknown, allowed: readonly { key: string }[], label: string, allowEmpty = false): ColumnCheck {
  if (!Array.isArray(raw)) return { ok: false, message: `${label}: invalid.` };
  if (raw.length === 0) return allowEmpty ? { ok: true, keys: [] } : { ok: false, message: `${label}: choose at least one column.` };
  if (raw.length > MAX_COLUMNS) return { ok: false, message: `${label}: too many columns.` };
  const known = new Set(allowed.map((c) => c.key));
  const seen = new Set<string>();
  for (const k of raw) {
    if (typeof k !== "string" || !known.has(k)) return { ok: false, message: `${label}: unknown column.` };
    if (seen.has(k)) return { ok: false, message: `${label}: a column is listed twice.` };
    seen.add(k);
  }
  return { ok: true, keys: raw as string[] };
}
