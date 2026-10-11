import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS, INVOICE_COLUMNS, ITEM_COLUMNS, validateColumnKeys } from "@/lib/export/columns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Each user's saved column choice and order. Stored per user and firm; Row Level Security limits rows to their owner.
export async function GET(request: Request) {
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;
  const { data } = await g.supabase
    .from("export_preferences")
    .select("columns, item_columns, include_items, date_format")
    .eq("firm_id", g.membership.firmId)
    .eq("user_id", g.user.id)
    .maybeSingle();
  const row = data as { columns: string[]; item_columns: string[]; include_items: boolean; date_format: string } | null;
  // Keys that no longer exist are dropped when reading, so an old preference never breaks an export.
  const known = new Set(INVOICE_COLUMNS.map((c) => c.key));
  const knownItems = new Set(ITEM_COLUMNS.map((c) => c.key));
  const columns = row ? row.columns.filter((k) => known.has(k)) : [];
  const itemColumns = row ? row.item_columns.filter((k) => knownItems.has(k)) : [];
  return json({
    columns: columns.length ? columns : DEFAULT_COLUMNS,
    itemColumns: itemColumns.length ? itemColumns : DEFAULT_ITEM_COLUMNS,
    includeItems: row?.include_items ?? false,
    dateFormat: row?.date_format === "dmy" ? "dmy" : "iso",
    saved: !!row,
  });
}

export async function PUT(request: Request) {
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  const body = await readJsonBody(request, 16 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);

  const cols = validateColumnKeys(b.columns, INVOICE_COLUMNS, "Columns");
  if (!cols.ok) return json({ error: cols.message }, 400);
  const itemCols = validateColumnKeys(b.itemColumns ?? [], ITEM_COLUMNS, "Item columns", true);
  if (!itemCols.ok) return json({ error: itemCols.message }, 400);

  const { error } = await g.supabase.from("export_preferences").upsert(
    {
      firm_id: g.membership.firmId,
      user_id: g.user.id,
      columns: cols.keys,
      item_columns: itemCols.keys,
      include_items: b.includeItems === true,
      date_format: b.dateFormat === "dmy" ? "dmy" : "iso",
    },
    { onConflict: "firm_id,user_id" }
  );
  if (error) {
    console.error("export_prefs_failed", { code: error.code ?? null });
    return json({ error: "Your column choice could not be saved." }, 500);
  }
  return json({ ok: true });
}
