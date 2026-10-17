import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import type { ExportInvoice } from "@/lib/export/columns";
import { CHUNK, INVOICE_SELECT } from "@/lib/export/run";
import { UUID_RE } from "@/lib/invoices/validation";
import { googleDriver } from "@/lib/integrations/google";
import { IntegrationError, userMessage } from "@/lib/integrations/http";
import { validateMapping } from "@/lib/integrations/mapping";
import { microsoftDriver } from "@/lib/integrations/microsoft";
import { booksPusher } from "@/lib/integrations/books";
import { MAX_PUSH_PER_RUN, pushInvoices } from "@/lib/integrations/push-sync";
import type { Pusher } from "@/lib/integrations/push-sync";
import { tallyPusher, validateTallyUrl } from "@/lib/integrations/tally-push";
import { booksTaxes, DEFAULT_ZOHO_REGION, isZohoRegion, zohoSheetDriver } from "@/lib/integrations/zoho";
import { validateTallyConfig } from "@/lib/tally/build";
import type { ExportItem } from "@/lib/export/columns";
import { managerWithConnection, providerError } from "@/lib/integrations/route-helpers";
import { getAccessToken, makeLedger, markNeedsReauth, readTallySecret, recordConnectionError } from "@/lib/integrations/store";
import { MAX_INVOICES_PER_SYNC, syncInvoices } from "@/lib/integrations/sync";
import type { SheetDriver } from "@/lib/integrations/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYNCS_PER_MINUTE = 100; // invoice rows touched per firm per minute, across all connections

// Sends VERIFIED invoices to the connected sheet. Body: { invoiceIds?: string[] }. Without ids, the oldest verified invoices
// that are not in this sheet yet are sent (up to 25 per run; run again for more). Failed rows are retried by running it again:
// the ledger and the sheet's AI Asis ID column make that safe.
// Everything that talks to the provider must be finished (or failed cleanly) before this, so the 60 s platform limit never cuts a sync
// in the middle. The rest of maxDuration is left for writing the results to the ledger.
const PROVIDER_BUDGET_MS = 48_000;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const deadlineAt = Date.now() + PROVIDER_BUDGET_MS;
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
  // Zoho Books and TallyPrime send one bill / voucher per invoice (no spreadsheet, no column mapping).
  const push = conn.provider === "zoho_books" || conn.provider === "tally_prime";
  const configured = conn.provider === "google_sheets" ? typeof tgt.spreadsheetId === "string" && typeof tgt.worksheetTitle === "string"
    : conn.provider === "microsoft_excel" ? typeof tgt.itemId === "string" && typeof tgt.worksheetId === "string"
    : conn.provider === "zoho_sheet" ? typeof tgt.resourceId === "string" && typeof tgt.worksheetName === "string"
    : conn.provider === "zoho_books" ? typeof tgt.orgId === "string" && typeof tgt.accountId === "string"
    : validateTallyConfig(tgt.config).ok;
  if (!configured || (!push && !mapping.ok)) return json({ error: push ? "Finish the setup of this connection before syncing." : "Choose a file and map the columns before syncing." }, 409);
  const maxInvoices = push ? MAX_PUSH_PER_RUN : MAX_INVOICES_PER_SYNC;

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await g.supabase.from("sync_records").select("id", { count: "exact", head: true }).eq("firm_id", firmId).gte("updated_at", since);
  if ((recent ?? 0) >= SYNCS_PER_MINUTE) return json({ error: "Too many syncs in the last minute. Wait a moment and try again." }, 429, { "Retry-After": "30" });

  // Which invoices
  let ids: string[];
  if (b.invoiceIds !== undefined) {
    const raw = b.invoiceIds;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxInvoices || !raw.every((v) => typeof v === "string" && UUID_RE.test(v))) {
      return json({ error: `Select between 1 and ${maxInvoices} invoices.` }, 400);
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
    ids = all.filter((id) => !done.has(id)).slice(0, maxInvoices);
  }
  if (ids.length === 0) return json({ results: [], summary: { total: 0 }, message: "Nothing to sync: every verified invoice is already in the sheet." });

  const { data: rows, error: qErr } = await g.supabase.from("invoice_review_list").select(INVOICE_SELECT).eq("firm_id", firmId).in("id", ids);
  if (qErr) return json({ error: "Invoices could not be loaded." }, 500);
  const invoices = (rows ?? []) as unknown as ExportInvoice[];

  let firstFailure: { code: string; message: string } | null = null;
  try {
    if (push) {
      const ledger = makeLedger(admin, conn, (code, message) => { firstFailure ??= { code, message }; });
      let pusher: Pusher;
      if (conn.provider === "tally_prime") {
        const secret = readTallySecret(conn);
        const u = secret ? validateTallyUrl(secret.url) : null;
        const cfg = validateTallyConfig(tgt.config);
        if (!secret || !u?.ok || !cfg.ok) return json({ error: "The Tally connection must be set up again.", code: "auth_expired" }, 409);
        pusher = tallyPusher({ url: u.url, token: secret.token, config: cfg.config });
      } else {
        const region = isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION;
        const token = await getAccessToken(admin, conn, { deadlineAt });
        const orgId = tgt.orgId as string;
        const items = new Map<string, ExportItem[]>();
        const { data: lines, error: lErr } = await g.supabase.from("line_items").select("invoice_id, position, description, hsn_code, quantity, unit, unit_price, discount_amount, taxable_amount, gst_rate, gst_amount, line_total").eq("firm_id", firmId).in("invoice_id", ids).order("position", { ascending: true });
        if (lErr) return json({ error: "Invoice lines could not be loaded." }, 500);
        for (const it of (lines ?? []) as unknown as ExportItem[]) { const l = items.get(it.invoice_id); if (l) l.push(it); else items.set(it.invoice_id, [it]); }
        pusher = booksPusher({ token, region, orgId, accountId: tgt.accountId as string, taxes: await booksTaxes(token, region, orgId, { deadlineAt }), items, opts: { deadlineAt } });
      }
      const results = await pushInvoices({ invoices, pusher, ledger });
      const failure = firstFailure as { code: string; message: string } | null;
      if (failure?.code === "auth_expired") await markNeedsReauth(admin, conn);
      else if (failure) await recordConnectionError(admin, conn, failure.message);
      const n = (st: string) => results.filter((r) => r.status === st).length;
      return json({ results, summary: { total: results.length, synced: n("synced") + n("recovered"), already: n("already_synced"), duplicates: n("duplicate"), notVerified: n("not_verified"), inProgress: n("in_progress"), failed: n("failed") } });
    }
    const token = await getAccessToken(admin, conn, { deadlineAt });
    const driver: SheetDriver = conn.provider === "google_sheets"
      ? googleDriver(token, tgt.spreadsheetId as string, tgt.worksheetTitle as string, { deadlineAt })
      : conn.provider === "zoho_sheet"
      ? zohoSheetDriver(token, isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION, tgt.resourceId as string, tgt.worksheetName as string, { deadlineAt })
      : microsoftDriver(token, { itemId: tgt.itemId as string, worksheetId: tgt.worksheetId as string, tableId: typeof tgt.tableId === "string" ? tgt.tableId : null }, { deadlineAt });
    const ledger = makeLedger(admin, conn, (code, message) => { firstFailure ??= { code, message }; });
    const results = await syncInvoices({ invoices, mapping: mapping.ok ? mapping.mapping : [], dateFormat: conn.date_format, driver, ledger });

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
