// Microsoft identity platform (authorization code + PKCE, offline_access) and the Microsoft Graph calls for Excel workbooks
// stored in the user's OneDrive. Permissions requested (delegated, no admin-wide access): Files.ReadWrite plus the sign-in scopes.
// AI Asis never sees the user's Microsoft password. Microsoft rotates the refresh token on every refresh: callers must save the new one.
import { IntegrationError, providerFetch } from "./http.ts";
import type { ProviderOpts } from "./http.ts";
import { colLetters } from "./mapping.ts";
import { codeChallenge } from "./oauth.ts";
import type { SheetDriver } from "./sync.ts";
import type { OAuthTokens } from "./google.ts";

export interface MicrosoftConfig { clientId: string; clientSecret: string; redirectUri: string; tenant: string }
export const MICROSOFT_SCOPES = ["openid", "profile", "email", "offline_access", "https://graph.microsoft.com/Files.ReadWrite"];
const GRAPH = "https://graph.microsoft.com/v1.0";

const authority = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0`;

export function microsoftAuthUrl(cfg: MicrosoftConfig, state: string, verifier: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: "code", redirect_uri: cfg.redirectUri, response_mode: "query", scope: MICROSOFT_SCOPES.join(" "),
    state, code_challenge: codeChallenge(verifier), code_challenge_method: "S256", prompt: "select_account",
  });
  return `${authority(cfg.tenant)}/authorize?${q.toString()}`;
}

const REAUTH = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required", "invalid_client", "unauthorized_client"]);

async function tokenRequest(cfg: MicrosoftConfig, form: Record<string, string>, idempotent: boolean, opts: ProviderOpts): Promise<OAuthTokens> {
  try {
    const r = await providerFetch(`${authority(cfg.tenant)}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: MICROSOFT_SCOPES.join(" "), ...form }).toString(),
    }, { idempotent, ...opts });
    const j = r.json ?? {};
    if (typeof j.access_token !== "string") throw new IntegrationError("bad_request", r.status);
    return { accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, expiresIn: Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600, idToken: typeof j.id_token === "string" ? j.id_token : undefined };
  } catch (e) {
    if (e instanceof IntegrationError && e.code === "bad_request" && e.providerError && REAUTH.has(e.providerError)) throw new IntegrationError("auth_expired", e.status, e.providerError);
    throw e;
  }
}

export function microsoftExchangeCode(cfg: MicrosoftConfig, code: string, verifier: string, opts: ProviderOpts = {}): Promise<OAuthTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: cfg.redirectUri }, false, opts);
}
export function microsoftRefresh(cfg: MicrosoftConfig, refreshToken: string, opts: ProviderOpts = {}): Promise<OAuthTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, true, opts);
}

// ---- Graph helpers ----
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ ...auth(token), "Content-Type": "application/json" });
const enc = encodeURIComponent;
const item = (itemId: string) => `${GRAPH}/me/drive/items/${enc(itemId)}/workbook`;
const strings = (row: unknown): string[] => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? "" : String(v))) : []);

export interface MsTarget { itemId: string; worksheetId: string; tableId: string | null }
export interface MsWorkbook { id: string; name: string; webUrl: string | null; lastModified: string | null }
export interface MsWorksheet { id: string; name: string; tables: { id: string; name: string }[] }

// Finds .xlsx workbooks in the user's OneDrive by name. Quotes are doubled so the search text cannot break out of the query.
export async function msSearchWorkbooks(token: string, query: string, opts: ProviderOpts = {}): Promise<MsWorkbook[]> {
  const q = enc(query.trim().slice(0, 100).replace(/'/g, "''"));
  const r = await providerFetch(`${GRAPH}/me/drive/root/search(q='${q}')?$select=id,name,webUrl,file,folder,lastModifiedDateTime&$top=50`, { headers: auth(token) }, { idempotent: true, ...opts });
  const list: any[] = Array.isArray(r.json?.value) ? r.json.value : [];
  return list
    .filter((v) => v && v.file && !v.folder && typeof v.name === "string" && /\.xlsx$/i.test(v.name) && typeof v.id === "string")
    .map((v) => ({ id: v.id as string, name: v.name as string, webUrl: typeof v.webUrl === "string" ? v.webUrl : null, lastModified: typeof v.lastModifiedDateTime === "string" ? v.lastModifiedDateTime : null }));
}

export async function msGetWorkbookStructure(token: string, itemId: string, opts: ProviderOpts = {}): Promise<MsWorksheet[]> {
  const ws = await providerFetch(`${item(itemId)}/worksheets?$select=id,name`, { headers: auth(token) }, { idempotent: true, ...opts });
  const sheets: { id: string; name: string }[] = (Array.isArray(ws.json?.value) ? ws.json.value : []).slice(0, 50)
    .filter((s: any) => typeof s?.id === "string" && typeof s?.name === "string").map((s: any) => ({ id: s.id, name: s.name }));
  const out: MsWorksheet[] = [];
  for (const s of sheets) {
    const t = await providerFetch(`${item(itemId)}/worksheets/${enc(s.id)}/tables?$select=id,name`, { headers: auth(token) }, { idempotent: true, ...opts });
    const tables = (Array.isArray(t.json?.value) ? t.json.value : []).filter((x: any) => typeof x?.id === "string").map((x: any) => ({ id: x.id as string, name: String(x.name ?? "Table") }));
    out.push({ ...s, tables });
  }
  return out;
}

const sheetBase = (t: { itemId: string; worksheetId: string }) => `${item(t.itemId)}/worksheets/${enc(t.worksheetId)}`;
const rangeUrl = (t: { itemId: string; worksheetId: string }, address: string) => `${sheetBase(t)}/range(address='${address}')`;

export async function msReadHeaders(token: string, t: MsTarget, opts: ProviderOpts = {}): Promise<string[]> {
  const url = t.tableId ? `${item(t.itemId)}/tables/${enc(t.tableId)}/headerRowRange?$select=values` : `${rangeUrl(t, `A1:${colLetters(59)}1`)}?$select=values`;
  const r = await providerFetch(url, { headers: auth(token) }, { idempotent: true, ...opts });
  const row = strings(r.json?.values?.[0]);
  while (row.length > 0 && row[row.length - 1] === "") row.pop(); // trailing empty cells are not part of the header
  return row;
}

export async function msWriteHeaders(token: string, t: MsTarget, headers: string[], opts: ProviderOpts = {}): Promise<void> {
  await providerFetch(`${rangeUrl(t, `A1:${colLetters(Math.max(headers.length, 1) - 1)}1`)}`, {
    method: "PATCH", headers: jsonHeaders(token), body: JSON.stringify({ values: [headers] }),
  }, { idempotent: true, ...opts });
}

export function microsoftDriver(token: string, t: MsTarget, opts: ProviderOpts = {}): SheetDriver {
  const sheetOnly = !t.tableId;
  return {
    guard: "excel", // Graph values are parsed like typed input, so text needs the leading-apostrophe guard
    readHeaders: () => msReadHeaders(token, t, opts),
    async readColumn(index: number) {
      const url = t.tableId
        ? `${item(t.itemId)}/tables/${enc(t.tableId)}/dataBodyRange?$select=values`
        : `${sheetBase(t)}/usedRange(valuesOnly=true)?$select=values`;
      const r = await providerFetch(url, { headers: auth(token) }, { idempotent: true, ...opts });
      const rows: unknown[] = Array.isArray(r.json?.values) ? r.json.values : [];
      return rows.map((row) => (Array.isArray(row) && row[index] !== undefined && row[index] !== null ? String(row[index]) : ""));
    },
    async append(rows) {
      if (!sheetOnly) {
        // A table grows by itself; all rows in one POST. Never retried after an unknown outcome.
        await providerFetch(`${item(t.itemId)}/tables/${enc(t.tableId as string)}/rows/add`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ values: rows }) }, { idempotent: false, ...opts });
        return { firstRow: 0 };
      }
      // Plain worksheet: write directly below the last used row.
      const used = await providerFetch(`${sheetBase(t)}/usedRange(valuesOnly=true)?$select=rowIndex,rowCount,columnIndex`, { headers: auth(token) }, { idempotent: true, ...opts });
      const firstRow = Number(used.json?.rowIndex ?? 0) + Number(used.json?.rowCount ?? 0) + 1;
      const width = Math.max(...rows.map((r) => r.length), 1);
      const address = `A${firstRow}:${colLetters(width - 1)}${firstRow + rows.length - 1}`;
      await providerFetch(rangeUrl(t, address), { method: "PATCH", headers: jsonHeaders(token), body: JSON.stringify({ values: rows }) }, { idempotent: false, ...opts });
      return { firstRow };
    },
  };
}
