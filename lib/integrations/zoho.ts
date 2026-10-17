// Zoho: OAuth (authorization code, offline access) per data centre, the Zoho Sheet driver and the Zoho Books calls.
// !! STATUS: written from Zoho's published API documentation, unit-tested with mocked HTTP only. NOT tested against a real Zoho account. !!
// Zoho keeps accounts in separate data centres (com, in, eu, ...). Every call must go to the data centre of the account, so the
// region is saved with the connection. Zoho refresh tokens do not rotate; access tokens last one hour.
import { IntegrationError, providerFetch } from "./http.ts";
import type { ProviderOpts } from "./http.ts";
import type { OAuthTokens } from "./google.ts";
import type { SheetDriver } from "./sync.ts";

export const ZOHO_REGIONS = ["com", "in", "eu", "com.au", "jp", "ca", "sa", "uk"] as const;
export type ZohoRegion = (typeof ZOHO_REGIONS)[number];
export const DEFAULT_ZOHO_REGION: ZohoRegion = "in";
export function isZohoRegion(v: unknown): v is ZohoRegion { return typeof v === "string" && (ZOHO_REGIONS as readonly string[]).includes(v); }

export interface ZohoConfig { clientId: string; clientSecret: string; redirectUri: string } // one config per provider (own redirect URI)
export const ZOHO_SHEET_SCOPES = ["ZohoSheet.dataAPI.READ", "ZohoSheet.dataAPI.UPDATE"];
export const ZOHO_BOOKS_SCOPES = ["ZohoBooks.contacts.CREATE", "ZohoBooks.contacts.READ", "ZohoBooks.bills.CREATE", "ZohoBooks.bills.READ", "ZohoBooks.bills.DELETE", "ZohoBooks.settings.READ", "ZohoBooks.accountants.READ"];

const accountsHost = (r: ZohoRegion) => `https://accounts.zoho.${r}`;
const sheetHost = (r: ZohoRegion) => `https://sheet.zoho.${r}`;
const booksHost = (r: ZohoRegion) => `https://www.zohoapis.${r}/books/v3`;

export function zohoAuthUrl(cfg: ZohoConfig, scopes: string[], region: ZohoRegion, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", scope: scopes.join(","), redirect_uri: cfg.redirectUri, access_type: "offline", prompt: "consent", state });
  return `${accountsHost(region)}/oauth/v2/auth?${q.toString()}`;
}

async function tokenRequest(region: ZohoRegion, form: Record<string, string>, idempotent: boolean, opts: ProviderOpts): Promise<OAuthTokens> {
  const r = await providerFetch(`${accountsHost(region)}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }, { idempotent, ...opts });
  const j = r.json ?? {};
  // Zoho answers HTTP 200 with { error: "invalid_code" } for a bad grant, so the body is checked too.
  if (typeof j.error === "string") throw new IntegrationError(j.error === "invalid_code" || j.error === "invalid_client" ? "auth_expired" : "bad_request", r.status, j.error);
  if (typeof j.access_token !== "string") throw new IntegrationError("bad_request", r.status);
  return { accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, expiresIn: Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600 };
}
export const zohoExchangeCode = (cfg: ZohoConfig, region: ZohoRegion, code: string, opts: ProviderOpts = {}) =>
  tokenRequest(region, { grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri }, false, opts);
export const zohoRefresh = (cfg: ZohoConfig, region: ZohoRegion, refreshToken: string, opts: ProviderOpts = {}) =>
  tokenRequest(region, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }, true, opts);

export async function zohoRevoke(region: ZohoRegion, refreshToken: string, opts: ProviderOpts = {}): Promise<boolean> {
  try {
    await providerFetch(`${accountsHost(region)}/oauth/v2/token/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }, { idempotent: true, ...opts });
    return true;
  } catch { return false; }
}

const auth = (token: string) => ({ Authorization: `Zoho-oauthtoken ${token}` });
const form = (token: string) => ({ ...auth(token), "Content-Type": "application/x-www-form-urlencoded" });
const jsonH = (token: string) => ({ ...auth(token), "Content-Type": "application/json" });
const strings = (row: unknown): string[] => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? "" : String(v))) : []);

// ---------------------------------------------------------------------------------------------------------------------------
// Zoho Sheet
// ---------------------------------------------------------------------------------------------------------------------------
const RESOURCE_ID = /^[A-Za-z0-9]{10,80}$/;
// The workbook is chosen by pasting its link (https://sheet.zoho.in/sheet/open/<resource id>) or the resource id itself.
export function parseZohoSheetId(input: string): string | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  if (RESOURCE_ID.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" || !/^sheet\.zoho\.[a-z.]+$/.test(u.hostname)) return null;
    const m = /\/(?:sheet\/open|open|sheet\/view)\/([A-Za-z0-9]{10,80})(?:\/|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch { return null; }
}

async function sheetCall(token: string, region: ZohoRegion, resourceId: string, params: Record<string, string>, idempotent: boolean, opts: ProviderOpts) {
  const r = await providerFetch(`${sheetHost(region)}/api/v2/${encodeURIComponent(resourceId)}`, { method: "POST", headers: form(token), body: new URLSearchParams(params).toString() }, { idempotent, ...opts });
  const j = r.json;
  // Zoho Sheet reports failures inside a 200 answer ({ status: "failure", error_code, error_message }).
  if (j && (j.status === "failure" || typeof j.error_code === "number")) {
    const c = Number(j.error_code);
    throw new IntegrationError(c === 2850 || c === 2851 ? "not_found" : c === 2801 || c === 2802 ? "auth_expired" : "bad_request", r.status, String(j.error_code ?? "failure"));
  }
  return j;
}

export async function zohoSheetWorksheets(token: string, region: ZohoRegion, resourceId: string, opts: ProviderOpts = {}): Promise<string[]> {
  const j = await sheetCall(token, region, resourceId, { method: "worksheet.list" }, true, opts);
  const list = Array.isArray(j?.worksheet_names) ? j.worksheet_names : Array.isArray(j?.worksheets) ? j.worksheets : [];
  return list.map((w: any) => (typeof w === "string" ? w : String(w?.worksheet_name ?? w?.name ?? ""))).filter((s: string) => s);
}

export interface ZohoSheetDriver extends SheetDriver { writeHeaders(headers: string[]): Promise<void> }

export function zohoSheetDriver(token: string, region: ZohoRegion, resourceId: string, worksheetName: string, opts: ProviderOpts = {}): ZohoSheetDriver {
  const grid = async (range: string): Promise<string[][]> => {
    const j = await sheetCall(token, region, resourceId, { method: "range.content.get", worksheet_name: worksheetName, range }, true, opts);
    const rows = Array.isArray(j?.range_details) ? j.range_details : Array.isArray(j?.content) ? j.content : [];
    return rows.map((r: any) => strings(Array.isArray(r) ? r : r?.row_details ?? r?.cells ?? []));
  };
  return {
    guard: "none",
    async readHeaders() { return (await grid("A1:BH1"))[0] ?? []; },
    async readColumn(index: number) {
      const col = colName(index);
      return (await grid(`${col}1:${col}20000`)).map((r: string[]) => r[0] ?? "");
    },
    async append(rows) {
      const headers = (await grid("A1:BH1"))[0] ?? [];
      const keys = headers.slice(0, rows[0]?.length ?? headers.length);
      if (new Set(keys.map((k) => k.trim().toLowerCase())).size !== keys.length || keys.some((k) => !k.trim())) throw new IntegrationError("header_changed"); // records.add needs unique header names
      const records = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
      const j = await sheetCall(token, region, resourceId, { method: "worksheet.records.add", worksheet_name: worksheetName, header_row: "1", json_data: JSON.stringify(records) }, false, opts); // never retried after an unknown outcome
      const first = Number(j?.records?.[0]?.row_index ?? j?.first_row ?? 0);
      return { firstRow: Number.isFinite(first) && first > 0 ? first : 0 };
    },
    async writeHeaders(headers) {
      await sheetCall(token, region, resourceId, { method: "worksheet.header.set", worksheet_name: worksheetName, header_row: "1", header_names: JSON.stringify(headers) }, true, opts);
    },
  };
}
function colName(index: number): string { let n = index + 1, s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

// ---------------------------------------------------------------------------------------------------------------------------
// Zoho Books (purchase invoice -> Bill)
// ---------------------------------------------------------------------------------------------------------------------------
const q = (orgId: string, extra: Record<string, string> = {}) => new URLSearchParams({ organization_id: orgId, ...extra }).toString();
function booksFail(j: any, status: number): never {
  // Books answers { code: 0, message } on success; any other code is a refusal even if HTTP is 200/201.
  const c = Number(j?.code);
  throw new IntegrationError(c === 57 || c === 14 ? "permission_denied" : c === 1002 || c === 1003 ? "not_found" : "bad_request", status, String(j?.code ?? ""));
}
async function booksGet(token: string, region: ZohoRegion, path: string, query: string, opts: ProviderOpts) {
  const r = await providerFetch(`${booksHost(region)}${path}?${query}`, { headers: auth(token) }, { idempotent: true, ...opts });
  if (r.json && Number(r.json.code) !== 0) booksFail(r.json, r.status);
  return r.json ?? {};
}

export interface BooksOrg { id: string; name: string }
export async function booksOrganizations(token: string, region: ZohoRegion, opts: ProviderOpts = {}): Promise<BooksOrg[]> {
  const r = await providerFetch(`${booksHost(region)}/organizations`, { headers: auth(token) }, { idempotent: true, ...opts });
  if (r.json && Number(r.json.code) !== 0) booksFail(r.json, r.status);
  return (Array.isArray(r.json?.organizations) ? r.json.organizations : []).map((o: any) => ({ id: String(o.organization_id ?? ""), name: String(o.name ?? "") })).filter((o: BooksOrg) => o.id);
}
export interface BooksAccount { id: string; name: string }
export async function booksExpenseAccounts(token: string, region: ZohoRegion, orgId: string, opts: ProviderOpts = {}): Promise<BooksAccount[]> {
  const j = await booksGet(token, region, "/chartofaccounts", q(orgId, { filter_by: "AccountType.Expense" }), opts);
  return (Array.isArray(j.chartofaccounts) ? j.chartofaccounts : []).map((a: any) => ({ id: String(a.account_id ?? ""), name: String(a.account_name ?? "") })).filter((a: BooksAccount) => a.id);
}
export interface BooksTax { id: string; name: string; percentage: number; inter: boolean }
export async function booksTaxes(token: string, region: ZohoRegion, orgId: string, opts: ProviderOpts = {}): Promise<BooksTax[]> {
  const j = await booksGet(token, region, "/settings/taxes", q(orgId), opts);
  return (Array.isArray(j.taxes) ? j.taxes : []).map((t: any) => ({ id: String(t.tax_id ?? ""), name: String(t.tax_name ?? ""), percentage: Number(t.tax_percentage), inter: /^igst/i.test(String(t.tax_name ?? "")) || String(t.tax_specification ?? "") === "inter" }))
    .filter((t: BooksTax) => t.id && Number.isFinite(t.percentage));
}
// The tax Zoho must apply to a line: the "IGST x%" tax for inter-state purchases, the "GST x%" group for intra-state ones. Null = not found.
export function pickTax(taxes: BooksTax[], ratePercent: number, inter: boolean): BooksTax | null {
  return taxes.find((t) => t.inter === inter && Math.abs(t.percentage - ratePercent) < 0.001 && (inter || /^gst/i.test(t.name) || /group/i.test(t.name) || !/^igst/i.test(t.name))) ?? null;
}

const norm = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
export async function booksFindOrCreateVendor(token: string, region: ZohoRegion, orgId: string, v: { name: string; gstin: string | null }, opts: ProviderOpts = {}): Promise<string> {
  const j = await booksGet(token, region, "/contacts", q(orgId, { contact_type: "vendor", contact_name_contains: v.name.slice(0, 100) }), opts);
  const list: any[] = Array.isArray(j.contacts) ? j.contacts : [];
  const hit = list.find((c) => (v.gstin && String(c.gst_no ?? "").toUpperCase() === v.gstin) || norm(String(c.contact_name ?? "")) === norm(v.name));
  if (hit?.contact_id) return String(hit.contact_id);
  const body: Record<string, unknown> = { contact_name: v.name.slice(0, 100), contact_type: "vendor", ...(v.gstin ? { gst_no: v.gstin, gst_treatment: "business_gst" } : { gst_treatment: "business_none" }) };
  const r = await providerFetch(`${booksHost(region)}/contacts?${q(orgId)}`, { method: "POST", headers: jsonH(token), body: JSON.stringify(body) }, { idempotent: false, ...opts });
  if (Number(r.json?.code) !== 0 || !r.json?.contact?.contact_id) booksFail(r.json, r.status);
  return String(r.json.contact.contact_id);
}

// A bill with this reference number (the AI Asis invoice id) is already in Zoho: the earlier answer was lost.
export async function booksFindBillByReference(token: string, region: ZohoRegion, orgId: string, reference: string, opts: ProviderOpts = {}): Promise<{ id: string; total: number } | null> {
  const j = await booksGet(token, region, "/bills", q(orgId, { reference_number: reference }), opts);
  const b = (Array.isArray(j.bills) ? j.bills : []).find((x: any) => String(x.reference_number ?? "") === reference);
  return b?.bill_id ? { id: String(b.bill_id), total: Number(b.total) } : null;
}
export async function booksCreateBill(token: string, region: ZohoRegion, orgId: string, bill: Record<string, unknown>, opts: ProviderOpts = {}): Promise<{ id: string; total: number }> {
  const r = await providerFetch(`${booksHost(region)}/bills?${q(orgId)}`, { method: "POST", headers: jsonH(token), body: JSON.stringify(bill) }, { idempotent: false, ...opts }); // never retried after an unknown outcome
  if (Number(r.json?.code) !== 0 || !r.json?.bill?.bill_id) booksFail(r.json, r.status);
  return { id: String(r.json.bill.bill_id), total: Number(r.json.bill.total) };
}
export async function booksDeleteBill(token: string, region: ZohoRegion, orgId: string, billId: string, opts: ProviderOpts = {}): Promise<boolean> {
  try {
    const r = await providerFetch(`${booksHost(region)}/bills/${encodeURIComponent(billId)}?${q(orgId)}`, { method: "DELETE", headers: auth(token) }, { idempotent: true, ...opts });
    return Number(r.json?.code) === 0;
  } catch { return false; }
}
