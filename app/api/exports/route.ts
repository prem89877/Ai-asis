import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/invoices/validation";
import { buildTables } from "@/lib/export/build";
import {
  INVOICE_COLUMNS, ITEM_COLUMNS, validateColumnKeys,
  type ExportInvoice, type ExportItem,
} from "@/lib/export/columns";
import { toCsv, type DateFormat } from "@/lib/export/csv";
import { getAvailableProfile } from "@/lib/export/profiles";
import { toXlsx } from "@/lib/export/xlsx";
import { hasExtractedData } from "@/lib/review/status";
import { DEBUG_ERRORS, errDetail } from "@/lib/api/debug"; // TEMP-DEBUG

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_INVOICES = 500;
const CHUNK = 50; // ids per query, keeps URLs short
const PAGE = 1000; // PostgREST default max rows per request
const EXPORTS_PER_MINUTE = 10;

const INVOICE_SELECT =
  "id, original_filename, status, created_at, vendor_name, vendor_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, currency, document_type, taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, tax_total, total_amount, confidence, review_flags, verified_at";
const ITEM_SELECT = "invoice_id, position, description, hsn_code, quantity, unit, unit_price, discount_amount, taxable_amount, gst_rate, gst_amount, line_total";

function istStamp(d: Date): string {
  const s = new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString();
  return `${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 16).replace(":", "")}`;
}

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
  // TEMP-DEBUG: also report an error from the rate-limit query itself
  if (DEBUG_ERRORS && recentErr) return json({ error: "Export check failed.", detail: `rate_limit_query: ${errDetail(recentErr)}` }, 500);

  try {
    // 1. Invoices of THIS firm only.
    const invoices: ExportInvoice[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await g.supabase
        .from("invoice_review_list")
        .select(INVOICE_SELECT)
        .eq("firm_id", firmId)
        .in("id", ids.slice(i, i + CHUNK));
      if (error) throw new Error(`invoice_query_failed: ${errDetail(error)}`);
      invoices.push(...((data ?? []) as unknown as ExportInvoice[]));
    }
    const eligible = invoices.filter((inv) => hasExtractedData(inv.status) && (!verifiedOnly || inv.status === "verified"));
    const skipped = ids.length - eligible.length;
    if (eligible.length === 0) {
      return json({ error: verifiedOnly ? "None of the selected invoices are verified." : "None of the selected invoices have extracted data to export yet." }, 422);
    }

    // 2. Items, only when asked for.
    const items = new Map<string, ExportItem[]>();
    if (includeItems) {
      const eligibleIds = eligible.map((e) => e.id);
      for (let i = 0; i < eligibleIds.length; i += CHUNK) {
        const chunk = eligibleIds.slice(i, i + CHUNK);
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await g.supabase
            .from("line_items")
            .select(ITEM_SELECT)
            .eq("firm_id", firmId)
            .in("invoice_id", chunk)
            .order("invoice_id", { ascending: true })
            .order("position", { ascending: true })
            .range(from, from + PAGE - 1);
          if (error) throw new Error(`item_query_failed: ${errDetail(error)}`);
          for (const it of (data ?? []) as unknown as ExportItem[]) {
            const list = items.get(it.invoice_id);
            if (list) list.push(it);
            else items.set(it.invoice_id, [it]);
          }
          if ((data ?? []).length < PAGE) break;
        }
      }
    }

    // 3. Build the file.
    const tables = buildTables(eligible, items, { format, columns: cols.keys, itemColumns: itemCols.keys, includeItems });
    const now = new Date();
    const bytes = format === "xlsx" ? toXlsx(tables, dateFormat, now) : toCsv(tables[0], dateFormat);
    const fileName = `ai-asis-invoices-${istStamp(now)}.${format}`;

    // 4. History. A failure here must not lose the file the user asked for, but it is logged.
    let exportId: string | null = null;
    const rec = await admin.rpc("record_export", {
      p_firm_id: firmId,
      p_user_id: g.user.id,
      p_format: format,
      p_profile: profile.id,
      p_invoice_ids: eligible.map((e) => e.id),
      p_skipped: skipped,
      p_column_keys: cols.keys,
      p_include_items: includeItems,
      p_file_name: fileName,
    });
    if (rec.error) console.error("export_history_failed", { code: rec.error.code ?? null, detail: DEBUG_ERRORS ? errDetail(rec.error) : undefined });
    else exportId = rec.data as string;

    // A plain ArrayBuffer is accepted as a body by every runtime and TypeScript version.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Content-Type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Count": String(eligible.length),
        "X-Export-Skipped": String(skipped),
        "X-Export-Unverified": String(eligible.filter((e) => e.status !== "verified").length),
        "X-Export-Recorded": exportId ? "1" : "0",
        ...(DEBUG_ERRORS && rec.error ? { "X-Export-History-Error": errDetail(rec.error).replace(/[^\x20-\x7e]/g, " ").slice(0, 300) } : {}), // TEMP-DEBUG
        "Access-Control-Expose-Headers": "X-Export-Count, X-Export-Skipped, X-Export-Unverified, X-Export-Recorded, X-Export-History-Error, Content-Disposition",
      },
    });
  } catch (err) {
    console.error("export_failed", { name: err instanceof Error ? err.message : "unknown" });
    return json({ error: "The export could not be created. Try again.", ...(DEBUG_ERRORS ? { detail: errDetail(err) } : {}) }, 500); // TEMP-DEBUG
  }
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
