import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import type { ExportInvoice } from "@/lib/export/columns";
import { CHUNK, INVOICE_SELECT } from "@/lib/export/run";
import { UUID_RE } from "@/lib/invoices/validation";
import { googleDriver } from "@/lib/integrations/google";
import { IntegrationError, userMessage } from "@/lib/integrations/http";
import { validateMapping } from "@/lib/integrations/mapping";
import { microsoftDriver } from "@/lib/integrations/microsoft";
import { managerWithConnection, providerError } from "@/lib/integrations/route-helpers";
import { getAccessToken, makeLedger, markNeedsReauth, recordConnectionError } from "@/lib/integrations/store";
import { MAX_INVOICES_PER_SYNC, syncInvoices } from "@/lib/integrations/sync";
import type { SheetDriver } from "@/lib/integrations/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYNCS_PER_MINUTE = 100; // invoice rows touched per firm per minute, across all connections

// Sends VERIFIED invoices to the connected sheet. Body: { invoiceIds?: string[] }. Without ids, the oldest verified invoices
// that are not in this sheet yet are sent (up to 25 per run; run again for more). Failed rows are retried by running it again:
// the ledger and the sheet's AI Asis ID column make that safe.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await managerWithConnection(request, params.id, true);
  if (!ctx.ok) return ctx.response;
  const { g, admin, conn } = ctx;
  const firmId = g.membership.firmId;

  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = (body.value ?? {}) as Record<string, unknown>;

  if (conn.status !== "active") return json({ error: "Reconnect your account first.", code: "auth_expired" }, 409);
  const mapping = validateMapping(conn.mapping);
  const tgt = conn.target as Record<string, unknown>;
  const configured = conn.provider === "google_sheets" ? typeof tgt.spreadsheetId === "string" && typeof tgt.worksheetTitle === "string" : typeof tgt.itemId === "string" && typeof tgt.worksheetId === "string";
  if (!configured || !mapping.ok) return json({ error: "Choose a file and map the columns before syncing." }, 409);

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await g.supabase.from("sync_records").select("id", { count: "exact", head: true }).eq("firm_id", firmId).gte("updated_at", since);
  if ((recent ?? 0) >= SYNCS_PER_MINUTE) return json({ error: "Too many syncs in the last minute. Wait a moment and try again." }, 429, { "Retry-After": "30" });

  // Which invoices
  let ids: string[];
  if (b.invoiceIds !== undefined) {
    const raw = b.invoiceIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_INVOICES_PER_SYNC || !raw.every((v) => typeof v === "string" && UUID_RE.test(v))) {
      return json({ error: `Select between 1 and ${MAX_INVOICES_PER_SYNC} invoices.` }, 400);
    }
    ids = Array.from(new Set(raw as string[]));
  } else {
    const { data: verified, error } = await g.supabase.from("invoice_review_list").select("id").eq("firm_id", firmId).eq("status", "verified").order("created_at", { ascending: true }).limit(500);
    if (error) return json({ error: "Invoices could not be loaded." }, 500);
    const all = ((verified ?? []) as { id: string }[]).map((r) => r.id);
    const done = new Set<string>();
    for (let i = 0; i < all.length; i += CHUNK) {
      const { data } = await g.supabase.from("sync_records").select("invoice_id").eq("firm_id", firmId).eq("connection_id", conn.id).eq("status", "synced").in("invoice_id", all.slice(i, i + CHUNK));
      for (const r of (data ?? []) as { invoice_id: string }[]) done.add(r.invoice_id);
    }
    ids = all.filter((id) => !done.has(id)).slice(0, MAX_INVOICES_PER_SYNC);
  }
  if (ids.length === 0) return json({ results: [], summary: { total: 0 }, message: "Nothing to sync: every verified invoice is already in the sheet." });

  const { data: rows, error: qErr } = await g.supabase.from("invoice_review_list").select(INVOICE_SELECT).eq("firm_id", firmId).in("id", ids);
  if (qErr) return json({ error: "Invoices could not be loaded." }, 500);
  const invoices = (rows ?? []) as unknown as ExportInvoice[];

  let firstFailure: { code: string; message: string } | null = null;
  try {
    const token = await getAccessToken(admin, conn);
    const driver: SheetDriver = conn.provider === "google_sheets"
      ? googleDriver(token, tgt.spreadsheetId as string, tgt.worksheetTitle as string)
      : microsoftDriver(token, { itemId: tgt.itemId as string, worksheetId: tgt.worksheetId as string, tableId: typeof tgt.tableId === "string" ? tgt.tableId : null });
    const ledger = makeLedger(admin, conn, (code, message) => { firstFailure ??= { code, message }; });
    const results = await syncInvoices({ invoices, mapping: mapping.mapping, dateFormat: conn.date_format, driver, ledger });

    const failure = firstFailure as { code: string; message: string } | null;
    if (failure?.code === "auth_expired") await markNeedsReauth(admin, conn);
    else if (failure) await recordConnectionError(admin, conn, failure.message);
    const count = (s: string) => results.filter((r) => r.status === s).length;
    return json({
      results,
      summary: { total: results.length, synced: count("synced") + count("recovered"), already: count("already_synced"), duplicates: count("duplicate"), notVerified: count("not_verified"), inProgress: count("in_progress"), failed: count("failed") },
    });
  } catch (e) {
    if (e instanceof IntegrationError && e.code === "auth_expired") await markNeedsReauth(admin, conn);
    else await recordConnectionError(admin, conn, userMessage(e).message);
    return providerError(e);
  }
}
