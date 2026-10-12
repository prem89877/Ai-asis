import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { UUID_RE } from "@/lib/invoices/validation";
import { generateExport } from "@/lib/export/run";
import { DEBUG_ERRORS } from "@/lib/api/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Downloads an export created with POST /api/exports. A plain GET link: browsers treat it as a normal download every time.
// The file is rebuilt from the saved request, so it reflects the CURRENT invoice values (files are not stored).
// Authorization: session + firm membership; the history row must belong to the user's firm.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;

  const { data: row } = await g.supabase
    .from("export_history")
    .select("format, column_keys, item_columns, include_items, verified_only, date_format, invoice_ids, file_name")
    .eq("id", params.id)
    .eq("firm_id", g.membership.firmId)
    .maybeSingle();
  const h = row as { format: "csv" | "xlsx"; column_keys: string[]; item_columns: string[]; include_items: boolean; verified_only: boolean; date_format: "iso" | "dmy"; invoice_ids: string[]; file_name: string | null } | null;
  if (!h) return json({ error: "Not found." }, 404);

  const result = await generateExport(g.supabase, g.membership.firmId, {
    format: h.format,
    columns: h.column_keys,
    itemColumns: h.item_columns,
    includeItems: h.include_items,
    verifiedOnly: h.verified_only,
    dateFormat: h.date_format,
    invoiceIds: h.invoice_ids,
  });
  if (!result.ok) return json({ error: result.error, ...(DEBUG_ERRORS && result.detail ? { detail: result.detail } : {}) }, result.status);

  const name = (h.file_name ?? `ai-asis-invoices.${h.format}`).replace(/[^A-Za-z0-9._-]/g, "_");
  // A plain ArrayBuffer is accepted as a body by every runtime and TypeScript version.
  const body = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
