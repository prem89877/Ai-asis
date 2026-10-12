// Server-side export generation shared by the "create export" and "download export" routes.
// Reads only the given firm's invoices through the caller's session (RLS) with an explicit firm_id filter.
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildTables } from "./build";
import type { ExportInvoice, ExportItem } from "./columns";
import { toCsv, type DateFormat } from "./csv";
import { toXlsx } from "./xlsx";
import { hasExtractedData } from "../review/status";
import { errDetail } from "../api/debug"; // TEMP-DEBUG

export const CHUNK = 50; // ids per query, keeps URLs short
const PAGE = 1000; // PostgREST default max rows per request

export const INVOICE_SELECT =
  "id, original_filename, status, created_at, vendor_name, vendor_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, currency, document_type, taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, tax_total, total_amount, confidence, review_flags, verified_at";
const ITEM_SELECT = "invoice_id, position, description, hsn_code, quantity, unit, unit_price, discount_amount, taxable_amount, gst_rate, gst_amount, line_total";

export interface ExportSpec {
  format: "csv" | "xlsx";
  columns: string[];
  itemColumns: string[];
  includeItems: boolean;
  verifiedOnly: boolean;
  dateFormat: DateFormat;
  invoiceIds: string[];
}

export type ExportResult =
  | { ok: true; bytes: Uint8Array; contentType: string; count: number; skipped: number; unverified: number; eligibleIds: string[] }
  | { ok: false; status: number; error: string; detail?: string };

export function istStamp(d: Date): string {
  const s = new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString();
  return `${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 19).replace(/:/g, "")}`; // seconds included so names never repeat
}

export async function generateExport(supabase: SupabaseClient, firmId: string, spec: ExportSpec): Promise<ExportResult> {
  try {
    const invoices: ExportInvoice[] = [];
    for (let i = 0; i < spec.invoiceIds.length; i += CHUNK) {
      const { data, error } = await supabase.from("invoice_review_list").select(INVOICE_SELECT).eq("firm_id", firmId).in("id", spec.invoiceIds.slice(i, i + CHUNK));
      if (error) throw new Error(`invoice_query_failed: ${errDetail(error)}`);
      invoices.push(...((data ?? []) as unknown as ExportInvoice[]));
    }
    const eligible = invoices.filter((inv) => hasExtractedData(inv.status) && (!spec.verifiedOnly || inv.status === "verified"));
    const skipped = spec.invoiceIds.length - eligible.length;
    if (eligible.length === 0) {
      return { ok: false, status: 422, error: spec.verifiedOnly ? "None of the selected invoices are verified." : "None of the selected invoices have extracted data to export yet." };
    }

    const items = new Map<string, ExportItem[]>();
    if (spec.includeItems) {
      const ids = eligible.map((e) => e.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
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

    const tables = buildTables(eligible, items, { format: spec.format, columns: spec.columns, itemColumns: spec.itemColumns, includeItems: spec.includeItems });
    const bytes = spec.format === "xlsx" ? toXlsx(tables, spec.dateFormat) : toCsv(tables[0], spec.dateFormat);
    return {
      ok: true,
      bytes,
      contentType: spec.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
      count: eligible.length,
      skipped,
      unverified: eligible.filter((e) => e.status !== "verified").length,
      eligibleIds: eligible.map((e) => e.id),
    };
  } catch (err) {
    console.error("export_failed", { name: err instanceof Error ? err.message : "unknown" });
    return { ok: false, status: 500, error: "The export could not be created. Try again.", detail: errDetail(err) };
  }
}
