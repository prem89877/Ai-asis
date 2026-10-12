import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { googleCreateSpreadsheet, googleDriver, googleGetSpreadsheet } from "@/lib/integrations/google";
import { parseSpreadsheetId } from "@/lib/integrations/mapping";
import { msGetWorkbookStructure, msReadHeaders, msSearchWorkbooks } from "@/lib/integrations/microsoft";
import { managerWithConnection, providerError } from "@/lib/integrations/route-helpers";
import { getAccessToken } from "@/lib/integrations/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MS_ID = /^[A-Za-z0-9{}!_.\- ]{1,200}$/;

// Read-only helper for the "choose a file" steps (plus "create a new Google spreadsheet"). Everything it returns comes from
// the connected user's own account; nothing here accepts a URL to fetch, only ids that are sent to Google / Microsoft APIs.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await managerWithConnection(request, params.id, true);
  if (!ctx.ok) return ctx.response;
  const { admin, conn } = ctx;
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);

  try {
    const token = await getAccessToken(admin, conn);

    if (conn.provider === "google_sheets") {
      if (b.action === "open") {
        const id = typeof b.input === "string" ? parseSpreadsheetId(b.input) : null;
        if (!id) return json({ error: "Paste the full link of the Google Sheet (https://docs.google.com/spreadsheets/d/...)." }, 400);
        const info = await googleGetSpreadsheet(token, id);
        return json({ spreadsheetId: id, name: info.title, sheets: info.sheets });
      }
      if (b.action === "create") {
        const title = typeof b.name === "string" && b.name.trim() && b.name.length <= 100 ? b.name.trim() : "AI Asis invoices";
        const created = await googleCreateSpreadsheet(token, title);
        return json({ spreadsheetId: created.id, name: created.title, sheets: created.sheets });
      }
      if (b.action === "headers") {
        const id = typeof b.spreadsheetId === "string" ? parseSpreadsheetId(b.spreadsheetId) : null;
        const ws = typeof b.worksheetTitle === "string" && b.worksheetTitle.length <= 255 ? b.worksheetTitle : null;
        if (!id || !ws) return json({ error: "Choose a spreadsheet and a worksheet." }, 400);
        return json({ headers: await googleDriver(token, id, ws).readHeaders() });
      }
      return json({ error: "Unknown action." }, 400);
    }

    if (b.action === "search") {
      return json({ workbooks: await msSearchWorkbooks(token, typeof b.query === "string" ? b.query : "") });
    }
    if (b.action === "structure") {
      if (typeof b.itemId !== "string" || !MS_ID.test(b.itemId)) return json({ error: "Choose a workbook." }, 400);
      return json({ worksheets: await msGetWorkbookStructure(token, b.itemId) });
    }
    if (b.action === "headers") {
      const itemId = typeof b.itemId === "string" && MS_ID.test(b.itemId) ? b.itemId : null;
      const worksheetId = typeof b.worksheetId === "string" && MS_ID.test(b.worksheetId) ? b.worksheetId : null;
      const tableId = typeof b.tableId === "string" && MS_ID.test(b.tableId) ? b.tableId : null;
      if (!itemId || !worksheetId) return json({ error: "Choose a workbook and a worksheet." }, 400);
      return json({ headers: await msReadHeaders(token, { itemId, worksheetId, tableId }) });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return providerError(e);
  }
}
