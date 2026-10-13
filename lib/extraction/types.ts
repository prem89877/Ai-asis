// Shared types for the extraction pipeline. No runtime code here.

export type FieldStatus = "present" | "missing" | "unreadable";

// What the model returns for every field. "present" + value 0 is a genuine zero.
// "missing" = not on the document. "unreadable" = on the document but cannot be read reliably.
export interface ModelField<T> {
  status: FieldStatus;
  value: T | null;
  confidence: number;
}

export const DOCUMENT_TYPES = [
  "tax_invoice",
  "bill_of_supply",
  "credit_note",
  "debit_note",
  "other_invoice",
  "not_an_invoice",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const HEADER_TEXT_FIELDS = [
  "currency",
  "supplier_name",
  "supplier_gstin",
  "buyer_name",
  "buyer_gstin",
  "invoice_number",
  "invoice_date",
  "place_of_supply",
] as const;
export const HEADER_AMOUNT_FIELDS = [
  "taxable_value",
  "discount_total",
  "cgst",
  "sgst",
  "igst",
  "cess",
  "grand_total",
] as const;
export const ITEM_TEXT_FIELDS = ["description", "hsn_sac", "unit"] as const;
export const ITEM_NUMBER_FIELDS = [
  "quantity",
  "unit_price",
  "discount",
  "taxable_value",
  "gst_rate",
  "tax_amount",
  "line_total",
] as const;

export type HeaderTextField = (typeof HEADER_TEXT_FIELDS)[number];
export type HeaderAmountField = (typeof HEADER_AMOUNT_FIELDS)[number];
export type ItemTextField = (typeof ITEM_TEXT_FIELDS)[number];
export type ItemNumberField = (typeof ITEM_NUMBER_FIELDS)[number];

export type ModelItem = { [K in ItemTextField]: ModelField<string> } & {
  [K in ItemNumberField]: ModelField<number>;
};

export type ModelOutput = {
  document_type: DocumentType;
  line_items: ModelItem[];
  // Optional: INR per 1 unit of the invoice currency, only when the document prints an exchange rate.
  exchange_rate?: ModelField<number>;
} & { [K in HeaderTextField]: ModelField<string> } & {
  [K in HeaderAmountField]: ModelField<number>;
};

// ---- Stored (normalized) shapes -------------------------------------------------------------

// value = readable value, zero = genuine zero, missing / unreadable as reported by the model,
// invalid = the model gave a value that failed normalization (bad date, impossible amount, ...).
export type FieldState = "value" | "zero" | "missing" | "unreadable" | "invalid";
export interface FieldMeta {
  state: FieldState;
  confidence: number;
  // Where the value was confirmed: "recheck" = two separate AI readings of the document gave the same
  // value; "human" = a reviewer typed or corrected it. Optional, so older records stay valid.
  source?: "recheck" | "human";
  // Set when the GSTIN check digit was fixed automatically. `from` = the raw extracted GSTIN, `to` = the validated one.
  // Kept so the review screen can toggle between them and the audit trail never loses the original.
  autoCorrected?: { from: string; to: string };
}

export type FlagSeverity = "error" | "warning" | "info";
export interface ReviewFlag {
  code: string;
  severity: FlagSeverity;
  field?: string;
  itemPosition?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface StoredExtracted {
  vendor_name: string | null;
  buyer_name: string | null;
  vendor_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_number_norm: string | null;
  invoice_date: string | null;
  place_of_supply: string | null;
  currency: string | null;
  exchange_rate?: number | null; // not stored in its own column; used by the arithmetic checks
  taxable_amount: number | null;
  discount_amount: number | null;
  cgst_amount: number | null;
  sgst_amount: number | null;
  igst_amount: number | null;
  cess_amount: number | null;
  total_amount: number | null;
  confidence: number | null;
  document_type: DocumentType;
  field_status: Record<string, FieldMeta>;
  review_flags: ReviewFlag[];
  raw_extraction: ModelOutput;
  extraction_model: string;
}

export interface StoredItem {
  description: string | null;
  hsn_code: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_amount: number | null;
  discount_type?: "PERCENT" | "AMOUNT" | null; // optional hint; when absent both readings are tried
  taxable_amount: number | null;
  gst_rate: number | null;
  gst_amount: number | null;
  line_total: number | null;
  field_status: Record<string, FieldMeta>;
}

export type JobOutcome = "completed" | "needs_review" | "failed";
