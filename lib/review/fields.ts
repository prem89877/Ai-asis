// Editable fields of an extracted invoice: one place that maps database columns, the field_status keys
// written by Phase 3, labels and input kinds. Used by the review API and the review screen.

export type FieldKind = "text" | "gstin" | "date" | "currency" | "amount" | "doctype";

export type HeaderColumn =
  | "vendor_name"
  | "vendor_gstin"
  | "buyer_name"
  | "buyer_gstin"
  | "invoice_number"
  | "invoice_date"
  | "place_of_supply"
  | "currency"
  | "document_type"
  | "taxable_amount"
  | "discount_amount"
  | "cgst_amount"
  | "sgst_amount"
  | "igst_amount"
  | "cess_amount"
  | "total_amount";

export interface HeaderFieldDef {
  column: HeaderColumn;
  statusKey: string; // key in extracted_data.field_status
  label: string;
  kind: FieldKind;
  maxLength?: number;
}

export const HEADER_FIELDS: readonly HeaderFieldDef[] = [
  { column: "vendor_name", statusKey: "supplier_name", label: "Supplier name", kind: "text", maxLength: 200 },
  { column: "vendor_gstin", statusKey: "supplier_gstin", label: "Supplier GSTIN", kind: "gstin" },
  { column: "buyer_name", statusKey: "buyer_name", label: "Buyer name", kind: "text", maxLength: 200 },
  { column: "buyer_gstin", statusKey: "buyer_gstin", label: "Buyer GSTIN", kind: "gstin" },
  { column: "invoice_number", statusKey: "invoice_number", label: "Invoice number", kind: "text", maxLength: 64 },
  { column: "invoice_date", statusKey: "invoice_date", label: "Invoice date", kind: "date" },
  { column: "place_of_supply", statusKey: "place_of_supply", label: "Place of supply", kind: "text", maxLength: 100 },
  { column: "currency", statusKey: "currency", label: "Currency", kind: "currency" },
  { column: "document_type", statusKey: "document_type", label: "Document type", kind: "doctype" },
  { column: "taxable_amount", statusKey: "taxable_value", label: "Taxable value", kind: "amount" },
  { column: "discount_amount", statusKey: "discount_total", label: "Discount", kind: "amount" },
  { column: "cgst_amount", statusKey: "cgst", label: "CGST", kind: "amount" },
  { column: "sgst_amount", statusKey: "sgst", label: "SGST / UTGST", kind: "amount" },
  { column: "igst_amount", statusKey: "igst", label: "IGST", kind: "amount" },
  { column: "cess_amount", statusKey: "cess", label: "Cess", kind: "amount" },
  { column: "total_amount", statusKey: "grand_total", label: "Grand total", kind: "amount" },
];

export const HEADER_COLUMNS: readonly HeaderColumn[] = HEADER_FIELDS.map((f) => f.column);

export type HeaderValues = Record<HeaderColumn, string | number | null>;

// document_type values a person may choose. "not_an_invoice" is never offered: such files fail extraction.
export const EDITABLE_DOCUMENT_TYPES = ["tax_invoice", "bill_of_supply", "credit_note", "debit_note", "other_invoice"] as const;
export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  tax_invoice: "Tax invoice",
  bill_of_supply: "Bill of supply",
  credit_note: "Credit note",
  debit_note: "Debit note",
  other_invoice: "Other invoice",
  not_an_invoice: "Not an invoice",
};

export interface ItemFieldDef {
  key: ItemColumn;
  statusKey: string;
  label: string;
  kind: "text" | "hsn" | "amount";
  dp?: number; // max decimal places
}

export type ItemColumn =
  | "description"
  | "hsn_code"
  | "quantity"
  | "unit"
  | "unit_price"
  | "discount_amount"
  | "taxable_amount"
  | "gst_rate"
  | "gst_amount"
  | "line_total";

export const ITEM_FIELDS: readonly ItemFieldDef[] = [
  { key: "description", statusKey: "description", label: "Description", kind: "text" },
  { key: "hsn_code", statusKey: "hsn_sac", label: "HSN/SAC", kind: "hsn" },
  { key: "quantity", statusKey: "quantity", label: "Qty", kind: "amount", dp: 3 },
  { key: "unit", statusKey: "unit", label: "Unit", kind: "text" },
  { key: "unit_price", statusKey: "unit_price", label: "Unit price", kind: "amount", dp: 4 },
  { key: "discount_amount", statusKey: "discount", label: "Discount", kind: "amount", dp: 2 },
  { key: "taxable_amount", statusKey: "taxable_value", label: "Taxable", kind: "amount", dp: 2 },
  { key: "gst_rate", statusKey: "gst_rate", label: "GST %", kind: "amount", dp: 2 },
  { key: "gst_amount", statusKey: "tax_amount", label: "GST amount", kind: "amount", dp: 2 },
  { key: "line_total", statusKey: "line_total", label: "Line total", kind: "amount", dp: 2 },
];

export type ItemValues = Record<ItemColumn, string | number | null>;

export const MAX_ITEMS = 300;
