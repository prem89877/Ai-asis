// Database side of the cloud integrations. SERVER ONLY (uses the service-role client and the encryption key).
// Tokens are stored encrypted (crypto.ts); browsers cannot read the token columns at all (column grants in 010_integrations.sql).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSiteUrl } from "../env.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { GOOGLE_SCOPES, googleRefresh } from "./google.ts";
import type { GoogleConfig, OAuthTokens } from "./google.ts";
import { IntegrationError } from "./http.ts";
import type { ProviderOpts } from "./http.ts";
import { MICROSOFT_SCOPES, microsoftRefresh } from "./microsoft.ts";
import { DEFAULT_ZOHO_REGION, isZohoRegion, ZOHO_BOOKS_SCOPES, ZOHO_SHEET_SCOPES, zohoRefresh } from "./zoho.ts";
import type { ZohoConfig } from "./zoho.ts";
import type { MicrosoftConfig } from "./microsoft.ts";
import { hashState } from "./oauth.ts";
import type { ClaimResult, FinishInfo, SyncLedger } from "./sync.ts";

export type Provider = "google_sheets" | "microsoft_excel" | "zoho_sheet" | "zoho_books" | "tally_prime";
// Providers that sign in with OAuth (tally_prime has no sign-in: its address is saved through its own route).
export type OAuthProvider = Exclude<Provider, "tally_prime">;
export function isProvider(p: string): p is Provider { return p === "google_sheets" || p === "microsoft_excel" || p === "zoho_sheet" || p === "zoho_books" || p === "tally_prime"; }
export function isOAuthProvider(p: string): p is OAuthProvider { return isProvider(p) && p !== "tally_prime"; }
export const isZohoProvider = (p: string): p is "zoho_sheet" | "zoho_books" => p === "zoho_sheet" || p === "zoho_books";

// The only columns browsers may read (same list as the column grant). Never add a token column here.
export const PUBLIC_CONNECTION_COLUMNS =
  "id, firm_id, connected_by, provider, account_email, status, scopes, target, mapping, date_format, last_error, last_error_at, last_synced_at, created_at, updated_at, region";

export interface Connection {
  id: string;
  firm_id: string;
  provider: Provider;
  status: "active" | "needs_reauth" | "revoked";
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_expires_at: string | null;
  target: Record<string, unknown>;
  mapping: unknown;
  date_format: "iso" | "dmy";
  account_email: string | null;
  region?: string | null;
}

export function providerConfigs(env: Record<string, string | undefined> = process.env): { google: GoogleConfig | null; microsoft: MicrosoftConfig | null; zohoSheet: ZohoConfig | null; zohoBooks: ZohoConfig | null } {
  const site = getSiteUrl();
  const google = env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
    ? { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${site}/api/integrations/oauth/google_sheets/callback` } : null;
  const microsoft = env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET
    ? { clientId: env.MICROSOFT_OAUTH_CLIENT_ID, clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET, tenant: env.MICROSOFT_OAUTH_TENANT || "common", redirectUri: `${site}/api/integrations/oauth/microsoft_excel/callback` } : null;
  const zoho = (id: string | undefined, secret: string | undefined, provider: string): ZohoConfig | null => (id && secret ? { clientId: id, clientSecret: secret, redirectUri: `${site}/api/integrations/oauth/${provider}/callback` } : null);
  // One Zoho "Server-based application" per product is the recommended setup, but a single client may serve both: ZOHO_OAUTH_* is the fallback.
  const zohoSheet = zoho(env.ZOHO_SHEET_CLIENT_ID || env.ZOHO_OAUTH_CLIENT_ID, env.ZOHO_SHEET_CLIENT_SECRET || env.ZOHO_OAUTH_CLIENT_SECRET, "zoho_sheet");
  const zohoBooks = zoho(env.ZOHO_BOOKS_CLIENT_ID || env.ZOHO_OAUTH_CLIENT_ID, env.ZOHO_BOOKS_CLIENT_SECRET || env.ZOHO_OAUTH_CLIENT_SECRET, "zoho_books");
  return { google, microsoft, zohoSheet, zohoBooks };
}

// Binds a stored secret to its firm and provider: a token copied into another firm's row cannot be decrypted.
export const tokenAad = (firmId: string, provider: string) => `${firmId}:${provider}`;
const stateAad = (hash: string) => `oauth_state:${hash}`;
const STATE_TTL_MS = 10 * 60_000;

// ---- OAuth state (single use, expires in 10 minutes, only its hash is stored) ----
export async function saveState(admin: SupabaseClient, s: { state: string; firmId: string; userId: string; provider: Provider; verifier: string; region?: string | null }): Promise<boolean> {
  try {
    const hash = hashState(s.state);
    await admin.from("oauth_states").delete().lt("expires_at", new Date().toISOString()); // housekeeping
    const { error } = await admin.from("oauth_states").insert({
      state_hash: hash, firm_id: s.firmId, user_id: s.userId, provider: s.provider,
      code_verifier_enc: encryptSecret(s.verifier, stateAad(hash)), expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      ...(s.region ? { region: s.region } : {}),
    });
    return !error;
  } catch {
    return false;
  }
}

export async function consumeState(admin: SupabaseClient, state: string): Promise<{ firmId: string; userId: string; provider: Provider; verifier: string; region?: string | null } | null> {
  try {
    const hash = hashState(state);
    // DELETE ... RETURNING makes the state single-use even if the callback is opened twice at the same moment.
    const { data, error } = await admin.from("oauth_states").delete().eq("state_hash", hash).select("firm_id, user_id, provider, code_verifier_enc, expires_at, region");
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) return null;
    if (Date.parse(row.expires_at) < Date.now() || !isProvider(row.provider)) return null;
    const verifier = decryptSecret(row.code_verifier_enc, stateAad(hash));
    return verifier ? { firmId: row.firm_id, userId: row.user_id, provider: row.provider, verifier, region: typeof row.region === "string" ? row.region : null } : null;
  } catch {
    return null;
  }
}

// ---- connections ----
export async function saveConnectionTokens(admin: SupabaseClient, c: { firmId: string; userId: string; provider: Provider; email: string | null; tokens: OAuthTokens; region?: string | null }): Promise<boolean> {
  try {
    if (!c.tokens.refreshToken) return false;
    const aad = tokenAad(c.firmId, c.provider);
    const { error } = await admin.from("integration_connections").upsert({
      firm_id: c.firmId, connected_by: c.userId, provider: c.provider, account_email: c.email, status: "active",
      scopes: (c.provider === "google_sheets" ? GOOGLE_SCOPES : c.provider === "zoho_sheet" ? ZOHO_SHEET_SCOPES : c.provider === "zoho_books" ? ZOHO_BOOKS_SCOPES : MICROSOFT_SCOPES).join(" ").slice(0, 1000),
      ...(isZohoProvider(c.provider) ? { region: isZohoRegion(c.region) ? c.region : DEFAULT_ZOHO_REGION } : {}),
      refresh_token_enc: encryptSecret(c.tokens.refreshToken, aad), access_token_enc: encryptSecret(c.tokens.accessToken, aad),
      access_expires_at: new Date(Date.now() + c.tokens.expiresIn * 1000).toISOString(), last_error: null, last_error_at: null,
    }, { onConflict: "firm_id,provider" }); // a reconnect keeps the chosen file and column mapping
    return !error;
  } catch {
    return false;
  }
}

export async function markNeedsReauth(admin: SupabaseClient, conn: Pick<Connection, "id" | "firm_id">): Promise<void> {
  await admin.from("integration_connections").update({
    status: "needs_reauth", last_error: "Your connection expired or was revoked. Reconnect your account.", last_error_at: new Date().toISOString(),
  }).eq("id", conn.id).eq("firm_id", conn.firm_id).neq("status", "revoked");
}

export async function recordConnectionError(admin: SupabaseClient, conn: Pick<Connection, "id" | "firm_id">, message: string): Promise<void> {
  await admin.from("integration_connections").update({ last_error: message.slice(0, 500), last_error_at: new Date().toISOString() }).eq("id", conn.id).eq("firm_id", conn.firm_id);
}

// Returns a valid access token, refreshing it when it is about to expire. Microsoft rotates the refresh token on every
// refresh, so the new one is saved. A revoked or expired grant marks the connection "needs_reauth" and throws auth_expired.
export async function getAccessToken(admin: SupabaseClient, conn: Connection, opts: ProviderOpts = {}): Promise<string> {
  if (conn.status !== "active") throw new IntegrationError("auth_expired");
  const aad = tokenAad(conn.firm_id, conn.provider);
  if (conn.access_token_enc && conn.access_expires_at && Date.parse(conn.access_expires_at) - Date.now() > 60_000) {
    const cached = decryptSecret(conn.access_token_enc, aad);
    if (cached) return cached;
  }
  const refresh = decryptSecret(conn.refresh_token_enc, aad);
  if (!refresh) { await markNeedsReauth(admin, conn); throw new IntegrationError("auth_expired"); }
  const cfg = providerConfigs();
  let tokens: OAuthTokens;
  try {
    if (conn.provider === "google_sheets") { if (!cfg.google) throw new IntegrationError("unknown"); tokens = await googleRefresh(cfg.google, refresh, opts); }
    else if (isZohoProvider(conn.provider)) {
      const zc = conn.provider === "zoho_sheet" ? cfg.zohoSheet : cfg.zohoBooks;
      if (!zc) throw new IntegrationError("unknown");
      tokens = await zohoRefresh(zc, isZohoRegion(conn.region) ? conn.region : DEFAULT_ZOHO_REGION, refresh, opts);
    } else if (conn.provider === "tally_prime") throw new IntegrationError("unknown"); // no tokens: never refreshed
    else { if (!cfg.microsoft) throw new IntegrationError("unknown"); tokens = await microsoftRefresh(cfg.microsoft, refresh, opts); }
  } catch (e) {
    if (e instanceof IntegrationError && e.code === "auth_expired") await markNeedsReauth(admin, conn);
    throw e;
  }
  await admin.from("integration_connections").update({
    access_token_enc: encryptSecret(tokens.accessToken, aad),
    access_expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    ...(tokens.refreshToken ? { refresh_token_enc: encryptSecret(tokens.refreshToken, aad) } : {}),
  }).eq("id", conn.id).eq("firm_id", conn.firm_id);
  return tokens.accessToken;
}

// ---- sync ledger (claim / finish through the database functions, which hold the locks) ----
export function makeLedger(admin: SupabaseClient, conn: Pick<Connection, "id" | "firm_id">, onFail: (code: string, message: string) => void): SyncLedger {
  let cleared = false;
  return {
    async claim(invoiceId: string, key: string | null): Promise<ClaimResult> {
      const { data, error } = await admin.rpc("claim_sync_record", { p_firm_id: conn.firm_id, p_connection_id: conn.id, p_invoice_id: invoiceId, p_dedupe_key: key });
      if (error || typeof data !== "string") throw new Error("sync ledger unavailable");
      if (data === "claimed" || data === "already_synced" || data === "in_progress") return { kind: data };
      if (data.startsWith("duplicate_of:")) return { kind: "duplicate_of", invoiceId: data.slice("duplicate_of:".length) };
      throw new Error("unexpected ledger answer");
    },
    async finish(invoiceId: string, r: FinishInfo): Promise<void> {
      const { error } = await admin.rpc("finish_sync_record", {
        p_firm_id: conn.firm_id, p_connection_id: conn.id, p_invoice_id: invoiceId, p_status: r.status,
        p_external_row: r.row && r.row > 0 ? r.row : null, p_error_code: r.code ?? null, p_error_message: r.message ?? null,
      });
      if (error) throw new Error("sync ledger unavailable");
      if (r.status === "failed") onFail(r.code ?? "unknown", r.message ?? "");
      else if (!cleared) {
        cleared = true; // a successful row clears an old error shown on the connection
        await admin.from("integration_connections").update({ last_error: null, last_error_at: null }).eq("id", conn.id).eq("firm_id", conn.firm_id);
      }
    },
  };
}

// ---- TallyPrime: no sign-in. The public address (and an optional access token) is the secret, stored encrypted like a token. ----
export interface TallySecret { url: string; token: string | null }
export async function saveTallyConnection(admin: SupabaseClient, c: { firmId: string; userId: string; secret: TallySecret; target: Record<string, unknown> }): Promise<boolean> {
  try {
    const { error } = await admin.from("integration_connections").upsert({
      firm_id: c.firmId, connected_by: c.userId, provider: "tally_prime", account_email: null, status: "active", scopes: null,
      refresh_token_enc: encryptSecret(JSON.stringify(c.secret), tokenAad(c.firmId, "tally_prime")), access_token_enc: null, access_expires_at: null,
      target: c.target, mapping: [], last_error: null, last_error_at: null,
    }, { onConflict: "firm_id,provider" });
    return !error;
  } catch {
    return false;
  }
}
export function readTallySecret(conn: Pick<Connection, "firm_id" | "refresh_token_enc">): TallySecret | null {
  const raw = decryptSecret(conn.refresh_token_enc, tokenAad(conn.firm_id, "tally_prime"));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<TallySecret>;
    return typeof j.url === "string" ? { url: j.url, token: typeof j.token === "string" && j.token ? j.token : null } : null;
  } catch {
    return null;
  }
}
