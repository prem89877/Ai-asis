import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { MAX_IDS, STATUS_GROUPS, flagKeysFor, parseListQuery } from "@/lib/review/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIST_COLUMNS =
  "id, original_filename, mime_type, size_bytes, status, created_at, vendor_name, vendor_gstin, buyer_gstin, invoice_number, invoice_date, place_of_supply, document_type, currency, taxable_amount, tax_total, total_amount, confidence, flag_count, error_count, warning_count, flag_codes, flag_keys, verified_at, data_updated_at, job_error_code";

// Searchable, sortable, filterable, paginated invoice list for the signed-in user's firm.
// Reads go through the user's session (RLS) and are also filtered by firm_id explicitly.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const q = parseListQuery(new URL(request.url).searchParams);

  let query = g.supabase
    .from("invoice_review_list")
    .select(q.idsOnly ? "id" : LIST_COLUMNS, { count: "exact" })
    .eq("firm_id", g.membership.firmId);

  if (q.status) query = query.in("status", [...STATUS_GROUPS[q.status]]);
  if (q.warning) query = query.overlaps("flag_keys", flagKeysFor(q.warning));
  if (q.from) query = query.gte("invoice_date", q.from);
  if (q.to) query = query.lte("invoice_date", q.to);
  if (q.q) {
    const like = `%${q.q}%`;
    query = query.or(
      ["vendor_name", "invoice_number", "original_filename", "vendor_gstin", "buyer_gstin"].map((c) => `${c}.ilike.${like}`).join(",")
    );
  }

  // Nulls last so empty values never crowd the top when sorting. A second key keeps paging stable.
  query = query.order(q.sort, { ascending: q.dir === "asc", nullsFirst: false }).order("id", { ascending: true });

  if (q.idsOnly) {
    const { data, error, count } = await query.range(0, MAX_IDS - 1);
    if (error) return json({ error: "The invoices could not be loaded. Try again." }, 500);
    return json({ ids: ((data ?? []) as unknown as { id: string }[]).map((r) => r.id), total: count ?? 0, capped: (count ?? 0) > MAX_IDS });
  }

  const from = (q.page - 1) * q.pageSize;
  const { data, error, count } = await query.range(from, from + q.pageSize - 1);
  if (error) {
    console.error("review_list_failed", { code: error.code ?? null });
    return json({ error: "The invoices could not be loaded. Try again." }, 500);
  }
  return json({ invoices: data ?? [], total: count ?? 0, page: q.page, pageSize: q.pageSize });
}
