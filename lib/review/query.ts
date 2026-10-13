// Parsing and whitelisting of the invoice-list query string. Nothing from the browser is passed to the
// database unchecked: columns, directions, statuses and flag codes come from fixed lists, and the free-text
// search is stripped of characters that have a meaning in PostgREST filter syntax.

export const STATUS_GROUPS = {
  processing: ["uploaded", "queued", "processing"],
  needs_review: ["needs_review", "completed"],
  verified: ["verified"],
  failed: ["failed"],
} as const;
export type StatusGroup = keyof typeof STATUS_GROUPS;

export const SORT_COLUMNS = [
  "created_at", "invoice_date", "vendor_name", "invoice_number", "taxable_amount", "tax_total", "total_amount", "status", "flag_count",
] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];

// Warning filters shown in the UI. Each maps to keys in invoice_review_list.flag_keys. A key is either a flag code
// ("possible_duplicate") or "code:field" ("missing_field:supplier_gstin") so GSTIN problems are not mixed up with
// other missing fields.
export const WARNING_FILTERS = {
  missing_gstin: [
    "missing_field:supplier_gstin", "unreadable_field:supplier_gstin", "missing_field:buyer_gstin", "unreadable_field:buyer_gstin",
    "invalid_gstin", "tax_without_gstin",
  ],
  missing_invoice_number: ["missing_required:invoice_number", "unreadable_field:invoice_number"],
  duplicate: ["possible_duplicate"],
  tax_mismatch: [
    "arithmetic_total_mismatch", "arithmetic_subtotal_mismatch", "arithmetic_line_mismatch", "gst_type_mismatch", "cgst_sgst_unequal",
    "item_tax_rate_mismatch", "invoice_tax_rate_mismatch", "tax_type_conflict", "tax_on_bill_of_supply",
    "tax_allocation_mismatch", "mixed_tax_unreconciled",
  ],
} as const;
export type WarningFilter = keyof typeof WARNING_FILTERS;

export function flagKeysFor(filter: WarningFilter): string[] {
  return [...WARNING_FILTERS[filter]];
}

export interface ListQuery {
  q: string;
  status: StatusGroup | null;
  warning: WarningFilter | null;
  sort: SortColumn;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
  from: string | null;
  to: string | null;
  idsOnly: boolean;
}

export const MAX_PAGE_SIZE = 100;
export const MAX_IDS = 500;

// Removes characters that are special in PostgREST `or=(...)` and in LIKE patterns.
export function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()%_*\\"'`:;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function isoDate(v: string | null): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

export function parseListQuery(params: URLSearchParams): ListQuery {
  const statusRaw = params.get("status");
  const warningRaw = params.get("warning");
  const sortRaw = params.get("sort");
  const page = Math.floor(Number(params.get("page") ?? 1));
  const size = Math.floor(Number(params.get("pageSize") ?? 25));
  return {
    q: sanitizeSearch(params.get("q") ?? ""),
    status: statusRaw && statusRaw in STATUS_GROUPS ? (statusRaw as StatusGroup) : null,
    warning: warningRaw && warningRaw in WARNING_FILTERS ? (warningRaw as WarningFilter) : null,
    sort: (SORT_COLUMNS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as SortColumn) : "created_at",
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
    pageSize: Number.isFinite(size) && size >= 1 ? Math.min(size, MAX_PAGE_SIZE) : 25,
    from: isoDate(params.get("from")),
    to: isoDate(params.get("to")),
    idsOnly: params.get("idsOnly") === "1",
  };
}
