// Row shapes returned by /api/review/invoices, used by the dashboard components.
export interface ReviewRow {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
  vendor_name: string | null;
  vendor_gstin: string | null;
  buyer_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  place_of_supply: string | null;
  document_type: string | null;
  currency: string | null;
  taxable_amount: number | null;
  tax_total: number | null;
  total_amount: number | null;
  confidence: number | null;
  flag_count: number;
  error_count: number;
  warning_count: number;
  flag_codes: string[] | null;
  flag_keys: string[] | null;
  verified_at: string | null;
  data_updated_at: string | null;
  job_error_code: string | null;
}

export interface Summary {
  total: number;
  processing: number;
  needs_review: number;
  needs_review_flagged: number;
  verified: number;
  failed: number;
  month_jobs: number;
  month_succeeded: number;
  month_failed: number;
  month_input_tokens: number;
  month_output_tokens: number;
  month_cost_usd: number;
  month_exports: number;
  month_exported_invoices: number;
}

export interface JobRow {
  id: string;
  status: string;
  error_code: string | null;
  finished_at: string | null;
  queued_at: string;
  filename: string;
}

export interface ExportRow {
  id: string;
  format: string;
  invoice_count: number;
  skipped_count: number;
  include_items: boolean;
  file_name: string | null;
  created_at: string;
}

// Warning chips shown in the table, derived from flag_keys.
export interface WarningChip {
  key: string;
  label: string;
  tone: "error" | "warning";
}

export function warningChips(row: Pick<ReviewRow, "flag_keys" | "flag_codes">): WarningChip[] {
  const keys = new Set(row.flag_keys ?? row.flag_codes ?? []);
  const has = (...k: string[]) => k.some((x) => keys.has(x));
  const out: WarningChip[] = [];
  if (has("missing_required:invoice_number", "unreadable_field:invoice_number")) out.push({ key: "invno", label: "Invoice no. missing", tone: "error" });
  if (has("missing_field:supplier_gstin", "unreadable_field:supplier_gstin", "tax_without_gstin")) out.push({ key: "gstin", label: "Supplier GSTIN missing", tone: "warning" });
  if (has("invalid_gstin")) out.push({ key: "badgstin", label: "GSTIN invalid", tone: "warning" });
  if (has("possible_duplicate")) out.push({ key: "dup", label: "Possible duplicate", tone: "warning" });
  if (has("arithmetic_total_mismatch", "arithmetic_subtotal_mismatch", "arithmetic_line_mismatch", "gst_type_mismatch", "cgst_sgst_unequal", "item_tax_rate_mismatch", "invoice_tax_rate_mismatch", "tax_type_conflict", "tax_on_bill_of_supply")) {
    out.push({ key: "tax", label: "Tax/total mismatch", tone: "error" });
  }
  return out;
}
