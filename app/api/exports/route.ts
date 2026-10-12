import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/invoices/validation";
import { INVOICE_COLUMNS, ITEM_COLUMNS, validateColumnKeys } from "@/lib/export/columns";
import type { DateFormat } from "@/lib/export/csv";
import { getAvailableProfile } from "@/lib/export/profiles";
import { generateExport, istStamp } from "@/lib/export/run";
import { DEBUG_ERRORS, errDetail } from "@/lib/api/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_INVOICES = 500;
const EXPORTS_PER_MINUTE = 10;

// Builds a real CSV or XLSX file from the selected invoices and returns it as a download.
// Authorization: session + firm membership; only invoices of the user's own firm are read (explicit firm_id filter on top of RLS).
export async function POST(request: Request) {
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  const { firmId } = g.membership;

  const body = await readJsonBody(request, 64 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);

  const format = b.format;
  if (format !== "csv" && format !== "xlsx") return json({ error: "Choose CSV or Excel." }, 400);
  const profileId = typeof b.profile === "string" ? b.profile : "standard";
  const profile = getAvailableProfile(profileId);
  if (!profile || !profile.formats.includes(format)) return json({ error: "This export format is not available." }, 400);

  const dateFormat: DateFormat = b.dateFormat === "dmy" ? "dmy" : "iso";
  const includeItems = b.includeItems === true;
  const verifiedOnly = b.verifiedOnly === true;

  const cols = validateColumnKeys(b.columns, INVOICE_COLUMNS, "Columns");
  if (!cols.ok) return json({ error: cols.message }, 400);
  const itemCols = validateColumnKeys(b.itemColumns ?? [], ITEM_COLUMNS, "Item columns", !includeItems);
  if (!itemCols.ok) return json({ error: itemCols.message }, 400);

  const rawIds = b.invoiceIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((v) => typeof v === "string" && UUID_RE.test(v))) {
    return json({ error: "Select at least one invoice." }, 400);
  }
  const ids = Array.from(new Set(rawIds as string[]));
  if (ids.length > MAX_INVOICES) return json({ error: `You can export up to ${MAX_INVOICES} invoices at a time.` }, 400);

  const admin = createAdminClient();
  if (!admin) return json({ error: "Exports are not configured on this server." }, 503);

  // Simple per-firm rate limit, from export history.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent, error: recentErr } = await g.supabase.from("export_history").select("id", { count: "exact", head: true }).eq("firm_id", firmId).gte("created_at", since);
  if ((recent ?? 0) >= EXPORTS_PER_MINUTE) {
    return json({ error: "Too many exports in the last minute. Wait a moment and try again." }, 429, { "Retry-After": "30" });
  }
  // If the rate-limit query itself fails, refuse (fail closed) instead of exporting without a limit.
  if (recentErr) {
    console.error("export_rate_limit_query_failed", { code: recentErr.code ?? null });
    return json({ error: "Export check failed. Try again.", ...(DEBUG_ERRORS ? { detail: `rate_limit_query: ${errDetail(recentErr)}` } : {}) }, 500);
  }

  // Build once here so every problem (no data, query errors) is reported now, with the exact reason.
  const spec = { format: format as "csv" | "xlsx", columns: cols.keys, itemColumns: itemCols.keys, includeItems, verifiedOnly, dateFormat, invoiceIds: ids };
  const result = await generateExport(g.supabase, firmId, spec);
  if (!result.ok) {
    return json({ error: result.error, ...(DEBUG_ERRORS && result.detail ? { detail: result.detail } : {}) }, result.status);
  }

  const fileName = `ai-asis-invoices-${istStamp(new Date())}.${format}`;
  const rec = await admin.rpc("record_export", {
    p_firm_id: firmId,
    p_user_id: g.user.id,
    p_format: format,
    p_profile: profile.id,
    p_invoice_ids: result.eligibleIds,
    p_skipped: result.skipped,
    p_column_keys: cols.keys,
    p_include_items: includeItems,
    p_file_name: fileName,
    p_item_columns: itemCols.keys,
    p_date_format: dateFormat,
    p_verified_only: verifiedOnly,
  });
  if (rec.error || !rec.data) {
    console.error("export_history_failed", { code: rec.error?.code ?? null });
    return json({ error: "The export could not be recorded. Try again.", ...(DEBUG_ERRORS ? { detail: `record_export: ${errDetail(rec.error)}` } : {}) }, 500);
  }

  // The browser then downloads the file with a normal link: GET /api/exports/:id/download
  return json({ id: rec.data as string, fileName, count: result.count, skipped: result.skipped, unverified: result.unverified });
}

// Recent export history for the firm (who, when, how many). Files are not stored, only this record.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase
    .from("export_history")
    .select("id, format, invoice_count, skipped_count, include_items, file_name, created_at")
    .eq("firm_id", g.membership.firmId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return json({ error: "The export history could not be loaded." }, 500);
  return json({ exports: data ?? [] });
}
