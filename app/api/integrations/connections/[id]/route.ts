import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { googleDriver, googleGetSpreadsheet, googleRevoke } from "@/lib/integrations/google";
import { booksExpenseAccounts, booksOrganizations, DEFAULT_ZOHO_REGION, isZohoRegion, parseZohoSheetId, zohoRevoke, zohoSheetDriver, zohoSheetWorksheets } from "@/lib/integrations/zoho";
import { validateTallyConfig } from "@/lib/tally/build";
import { IntegrationError } from "@/lib/integrations/http";
import { headersMatch, parseSpreadsheetId, validateMapping } from "@/lib/integrations/mapping";
import { msGetWorkbookStructure, msReadHeaders, msWriteHeaders } from "@/lib/integrations/microsoft";
import { managerWithConnection, providerError } from "@/lib/integrations/route-helpers";
import { getAccessToken, isZohoProvider, tokenAad } from "@/lib/integrations/store";
import { decryptSecret } from "@/lib/integrations/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MS_ID = /^[A-Za-z0-9{}!_.\- ]{1,200}$/;
const name = (v: unknown, max = 255): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

// Disconnect = revoke at the provider where the provider supports it, then delete our stored tokens.
// The sync history is kept. Google supports token revocation. Microsoft has no revocation call for a delegated refresh token:
// we delete our copy, and the user can also remove the app at https://account.live.com/consent/Manage (personal)
// or https://myapps.microsoft.com (work or school).
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const ctx = await managerWithConnection(request, params.id, true);
  if (!ctx.ok) return ctx.response;
  const { admin, conn } = ctx;
  let revokedAtProvider = false;
  if (conn.provider === "google_sheets" && conn.refresh_token_enc) {
    const refresh = decryptSecret(conn.refresh_token_enc, tokenAad(conn.firm_id, conn.provider));
    if (refresh) revokedAtProvider = await googleRevoke(refresh);
  }
  if (isZohoProvider(conn.provider) && conn.refresh_token_enc) {
    const refresh = decryptSecret(conn.refresh_token_enc, tokenAad(conn.firm_id, conn.provider));
    if (refresh) revokedAtProvider = await zohoRevoke(isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION, refresh);
  }
  const { error } = await admin.from("integration_connections").update({
    status: "revoked", refresh_token_enc: null, access_token_enc: null, access_expires_at: null, target: {}, mapping: [],
    last_error: null, last_error_at: null,
  }).eq("id", conn.id).eq("firm_id", conn.firm_id);
  if (error) return json({ error: "The connection could not be removed. Try again." }, 500);
  return json({ ok: true, revokedAtProvider });
}

// Saves the chosen file, worksheet (or table) and column mapping after checking them against the live file.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await managerWithConnection(request, params.id, true);
  if (!ctx.ok) return ctx.response;
  const { admin, conn } = ctx;
  const body = await readJsonBody(request, 32 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);

  // Zoho Books and TallyPrime send one bill / voucher per invoice: they have no column mapping.
  if (conn.provider === "zoho_books" || conn.provider === "tally_prime") return patchPushTarget(ctx, b);
  const mapping = validateMapping(b.mapping);
  if (!mapping.ok) return json({ error: mapping.message }, 400);
  const dateFormat = b.dateFormat === "dmy" ? "dmy" : "iso";
  const writeHeaders = b.writeHeaders === true;
  const t = (b.target ?? {}) as Record<string, unknown>;

  try {
    const token = await getAccessToken(admin, conn);
    let target: Record<string, unknown>;

    if (conn.provider === "google_sheets") {
      const spreadsheetId = typeof t.spreadsheetId === "string" ? parseSpreadsheetId(t.spreadsheetId) : null;
      const worksheetTitle = name(t.worksheetTitle);
      if (!spreadsheetId || !worksheetTitle) return json({ error: "Choose a spreadsheet and a worksheet." }, 400);
      const info = await googleGetSpreadsheet(token, spreadsheetId);
      if (!info.sheets.some((s) => s.title === worksheetTitle)) return json({ error: "That worksheet was not found in the spreadsheet." }, 400);
      const driver = googleDriver(token, spreadsheetId, worksheetTitle);
      let headers = await driver.readHeaders();
      if (writeHeaders) {
        if (headers.some((h) => h.trim() !== "")) return json({ error: "The sheet already has a header row. Map its columns instead." }, 400);
        await driver.writeHeaders(mapping.mapping.map((m) => m.header));
        headers = mapping.mapping.map((m) => m.header);
      }
      if (!headersMatch(mapping.mapping, headers)) return json({ error: "The mapping does not match the sheet's header row. Reload the columns and try again." }, 400);
      target = { spreadsheetId, spreadsheetName: info.title, worksheetTitle };
    } else if (conn.provider === "zoho_sheet") {
      const region = isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION;
      const resourceId = typeof t.resourceId === "string" ? parseZohoSheetId(t.resourceId) : null;
      const worksheetName = name(t.worksheetName);
      if (!resourceId || !worksheetName) return json({ error: "Choose a workbook and a worksheet." }, 400);
      if (!(await zohoSheetWorksheets(token, region, resourceId)).includes(worksheetName)) return json({ error: "That worksheet was not found in the workbook." }, 400);
      const driver = zohoSheetDriver(token, region, resourceId, worksheetName);
      let headers = await driver.readHeaders();
      if (writeHeaders) {
        if (headers.some((h) => h.trim() !== "")) return json({ error: "The sheet already has a header row. Map its columns instead." }, 400);
        await driver.writeHeaders(mapping.mapping.map((m) => m.header));
        headers = mapping.mapping.map((m) => m.header);
      }
      if (!headersMatch(mapping.mapping, headers)) return json({ error: "The mapping does not match the sheet's header row. Reload the columns and try again." }, 400);
      target = { resourceId, workbookName: name(t.workbookName) ?? "Zoho Sheet workbook", worksheetName };
    } else {
      const itemId = typeof t.itemId === "string" && MS_ID.test(t.itemId) ? t.itemId : null;
      const worksheetId = typeof t.worksheetId === "string" && MS_ID.test(t.worksheetId) ? t.worksheetId : null;
      const tableId = t.tableId === null || t.tableId === undefined ? null : typeof t.tableId === "string" && MS_ID.test(t.tableId) ? t.tableId : undefined;
      if (!itemId || !worksheetId || tableId === undefined) return json({ error: "Choose a workbook and a worksheet." }, 400);
      const structure = await msGetWorkbookStructure(token, itemId);
      const ws = structure.find((s) => s.id === worksheetId);
      if (!ws) return json({ error: "That worksheet was not found in the workbook." }, 400);
      const table = tableId ? ws.tables.find((x) => x.id === tableId) : null;
      if (tableId && !table) return json({ error: "That table was not found on the worksheet." }, 400);
      const ms = { itemId, worksheetId, tableId };
      let headers = await msReadHeaders(token, ms);
      if (writeHeaders) {
        if (tableId) return json({ error: "A table already has its own headers. Map its columns instead." }, 400);
        if (headers.some((h) => h.trim() !== "")) return json({ error: "The worksheet already has a header row. Map its columns instead." }, 400);
        await msWriteHeaders(token, ms, mapping.mapping.map((m) => m.header));
        headers = mapping.mapping.map((m) => m.header);
      }
      if (!headersMatch(mapping.mapping, headers)) return json({ error: "The mapping does not match the header row. Reload the columns and try again." }, 400);
      target = { itemId, workbookName: name(t.workbookName) ?? "Workbook", worksheetId, worksheetName: ws.name, tableId, tableName: table?.name ?? null };
    }

    const { error } = await admin.from("integration_connections").update({ target, mapping: mapping.mapping, date_format: dateFormat, last_error: null, last_error_at: null }).eq("id", conn.id).eq("firm_id", conn.firm_id);
    if (error) return json({ error: "The settings could not be saved. Try again." }, 500);
    return json({ ok: true, target });
  } catch (e) {
    if (e instanceof IntegrationError) return providerError(e);
    return json({ error: "The settings could not be saved. Try again." }, 500);
  }
}

// Zoho Books: which organisation and which expense account the bills use. TallyPrime: the ledger names. Both are checked before saving.
async function patchPushTarget(ctx: Extract<Awaited<ReturnType<typeof managerWithConnection>>, { ok: true }>, b: Record<string, unknown>): Promise<Response> {
  const { admin, conn } = ctx;
  try {
    let target: Record<string, unknown>;
    if (conn.provider === "tally_prime") {
      const cfg = validateTallyConfig(b.config);
      if (!cfg.ok) return json({ error: cfg.message }, 400);
      target = { ...(conn.target as Record<string, unknown>), config: cfg.config };
    } else {
      const region = isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION;
      const t = (b.target ?? {}) as Record<string, unknown>;
      const orgId = typeof t.orgId === "string" && /^\d{4,30}$/.test(t.orgId) ? t.orgId : null;
      const accountId = typeof t.accountId === "string" && /^\d{4,30}$/.test(t.accountId) ? t.accountId : null;
      if (!orgId || !accountId) return json({ error: "Choose a Zoho Books organisation and an expense account." }, 400);
      const token = await getAccessToken(admin, conn);
      const org = (await booksOrganizations(token, region)).find((o) => o.id === orgId);
      if (!org) return json({ error: "That organisation was not found in your Zoho Books account." }, 400);
      const acc = (await booksExpenseAccounts(token, region, orgId)).find((a) => a.id === accountId);
      if (!acc) return json({ error: "That expense account was not found in the organisation." }, 400);
      target = { orgId, orgName: org.name, accountId, accountName: acc.name };
    }
    const { error } = await admin.from("integration_connections").update({ target, last_error: null, last_error_at: null }).eq("id", conn.id).eq("firm_id", conn.firm_id);
    if (error) return json({ error: "The settings could not be saved. Try again." }, 500);
    return json({ ok: true, target });
  } catch (e) {
    if (e instanceof IntegrationError) return providerError(e);
    return json({ error: "The settings could not be saved. Try again." }, 500);
  }
}
