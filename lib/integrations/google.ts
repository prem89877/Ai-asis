// Google OAuth (authorization code + PKCE, offline access) and the few Google Sheets calls AI Asis needs.
// Scope: openid, email and https://www.googleapis.com/auth/spreadsheets. AI Asis never sees the user's Google password.
import { IntegrationError, providerFetch } from "./http.ts";
import type { ProviderOpts } from "./http.ts";
import { colLetters, quoteSheet } from "./mapping.ts";
import { codeChallenge } from "./oauth.ts";
import type { SheetDriver } from "./sync.ts";

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }
export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresIn: number; idToken?: string }

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export function googleAuthUrl(cfg: GoogleConfig, state: string, verifier: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    state, code_challenge: codeChallenge(verifier), code_challenge_method: "S256",
    access_type: "offline", prompt: "consent", // "consent" makes Google return a refresh token on every connect
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function tokenRequest(form: Record<string, string>, idempotent: boolean, opts: ProviderOpts): Promise<OAuthTokens> {
  try {
    const r = await providerFetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
    }, { idempotent, ...opts });
    const j = r.json ?? {};
    if (typeof j.access_token !== "string") throw new IntegrationError("bad_request", r.status);
    return { accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null, expiresIn: Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600, idToken: typeof j.id_token === "string" ? j.id_token : undefined };
  } catch (e) {
    // A revoked, expired or already-used grant is an authorisation problem the user fixes by reconnecting.
    if (e instanceof IntegrationError && e.code === "bad_request" && (e.providerError === "invalid_grant" || e.providerError === "invalid_client" || e.providerError === "unauthorized_client")) {
      throw new IntegrationError("auth_expired", e.status, e.providerError);
    }
    throw e;
  }
}

export function googleExchangeCode(cfg: GoogleConfig, code: string, verifier: string, opts: ProviderOpts = {}): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri }, false, opts);
}
export function googleRefresh(cfg: GoogleConfig, refreshToken: string, opts: ProviderOpts = {}): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }, true, opts);
}

// Revokes the refresh token at Google. Returns true when Google confirmed.
export async function googleRevoke(refreshToken: string, opts: ProviderOpts = {}): Promise<boolean> {
  try {
    await providerFetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }).toString() }, { idempotent: true, ...opts });
    return true;
  } catch {
    return false;
  }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const jsonHeaders = (token: string) => ({ ...auth(token), "Content-Type": "application/json" });
const strings = (row: unknown): string[] => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? "" : String(v))) : []);

export interface SpreadsheetInfo { title: string; sheets: { id: number; title: string }[] }
function parseInfo(j: any): SpreadsheetInfo {
  const sheets = Array.isArray(j?.sheets) ? j.sheets.map((s: any) => ({ id: Number(s?.properties?.sheetId ?? 0), title: String(s?.properties?.title ?? "") })).filter((s: { title: string }) => s.title) : [];
  return { title: String(j?.properties?.title ?? "Spreadsheet"), sheets };
}

export async function googleGetSpreadsheet(token: string, spreadsheetId: string, opts: ProviderOpts = {}): Promise<SpreadsheetInfo> {
  const r = await providerFetch(`${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title)`, { headers: auth(token) }, { idempotent: true, ...opts });
  return parseInfo(r.json);
}

// Creates a new, empty spreadsheet owned by the connected user.
export async function googleCreateSpreadsheet(token: string, title: string, opts: ProviderOpts = {}): Promise<SpreadsheetInfo & { id: string }> {
  const r = await providerFetch(SHEETS, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ properties: { title } }) }, { idempotent: false, ...opts });
  const id = typeof r.json?.spreadsheetId === "string" ? r.json.spreadsheetId : null;
  if (!id) throw new IntegrationError("bad_request", r.status);
  return { id, ...parseInfo(r.json) };
}

export interface GoogleDriver extends SheetDriver { writeHeaders(headers: string[]): Promise<void> }

export function googleDriver(token: string, spreadsheetId: string, worksheetTitle: string, opts: ProviderOpts = {}): GoogleDriver {
  const base = `${SHEETS}/${encodeURIComponent(spreadsheetId)}`;
  const range = (a1: string) => `${encodeURIComponent(quoteSheet(worksheetTitle))}!${a1}`;
  return {
    guard: "none", // RAW input keeps text exactly as sent
    async readHeaders() {
      const r = await providerFetch(`${base}/values/${range("1:1")}`, { headers: auth(token) }, { idempotent: true, ...opts });
      return strings(r.json?.values?.[0]);
    },
    async readColumn(index: number) {
      const L = colLetters(index);
      const r = await providerFetch(`${base}/values/${range(`${L}:${L}`)}?majorDimension=COLUMNS`, { headers: auth(token) }, { idempotent: true, ...opts });
      return strings(r.json?.values?.[0]);
    },
    async append(rows) {
      const r = await providerFetch(`${base}/values/${range("A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ values: rows }),
      }, { idempotent: false, ...opts }); // never retried after an unknown outcome: it could duplicate rows
      const m = /!\$?[A-Z]+\$?(\d+)/.exec(String(r.json?.updates?.updatedRange ?? ""));
      return { firstRow: m ? Number(m[1]) : 0 };
    },
    async writeHeaders(headers) {
      await providerFetch(`${base}/values/${range(`A1:${colLetters(Math.max(headers.length, 1) - 1)}1`)}?valueInputOption=RAW`, {
        method: "PUT", headers: jsonHeaders(token), body: JSON.stringify({ values: [headers] }),
      }, { idempotent: true, ...opts });
    },
  };
}
