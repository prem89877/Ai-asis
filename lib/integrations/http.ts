// One place for every call to Google / Microsoft: timeouts, classification of errors, safe retries.
//  * GET-like (idempotent) calls are retried on 5xx, network errors and timeouts.
//  * Appends (idempotent: false) are NEVER retried after a 5xx, network error or timeout: the provider may have written the
//    rows already and a retry could duplicate them. The sync step checks the sheet's AI Asis ID column before trying again.
//  * 429 (rate limit) means "not processed", so it is retried for every call, honouring Retry-After.
export type ErrorCode =
  | "auth_expired" | "permission_denied" | "not_found" | "rate_limited" | "server_error" | "bad_request"
  | "timeout" | "network" | "header_changed" | "unknown";

export class IntegrationError extends Error {
  code: ErrorCode;
  status: number;
  providerError: string | null; // short machine code from the provider body (for example "invalid_grant"); never shown to users
  constructor(code: ErrorCode, status = 0, providerError: string | null = null) {
    super(code);
    this.name = "IntegrationError";
    this.code = code;
    this.status = status;
    this.providerError = providerError;
  }
}

export function classifyStatus(status: number): ErrorCode {
  if (status === 401) return "auth_expired";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_request";
}

const MESSAGES: Record<ErrorCode, string> = {
  auth_expired: "Your connection has expired or was revoked. Reconnect your account.",
  permission_denied: "AI Asis does not have permission for this file. Check that the file is in your account and that you allowed access, or reconnect.",
  not_found: "The file or worksheet was not found. It may have been moved or deleted. Choose it again.",
  rate_limited: "The provider is limiting requests right now. Wait a minute and press Sync again.",
  server_error: "The provider had a problem. Press Sync again in a few minutes.",
  bad_request: "The provider did not accept the request. Check the worksheet and the column mapping.",
  timeout: "The provider took too long to answer. Press Sync again; rows that were already written are not added twice.",
  network: "The provider could not be reached. Check that the file is available and press Sync again.",
  header_changed: "The header row of the sheet changed. Restore it or map the columns again.",
  unknown: "Something went wrong. Try again.",
};

// Messages for the browser: never the provider's text, never an internal error text.
export function userMessage(e: unknown): { code: ErrorCode; message: string } {
  if (e instanceof IntegrationError) return { code: e.code, message: MESSAGES[e.code] ?? MESSAGES.unknown };
  return { code: "unknown", message: MESSAGES.unknown };
}

export interface FetchOptions {
  idempotent: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}
export type ProviderOpts = Partial<Omit<FetchOptions, "idempotent">>;
export interface ProviderResponse { status: number; json: any; headers: Headers }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(4000, 400 * 2 ** (attempt - 1));

function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 30) * 1000 : backoff(attempt);
}

async function readBody(res: Response): Promise<any> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
function providerCode(body: any): string | null {
  const e = body?.error;
  const v = typeof e === "string" ? e : typeof e?.status === "string" ? e.status : typeof e?.code === "string" ? e.code : null;
  return v ? v.slice(0, 100) : null;
}

export async function providerFetch(url: string, init: RequestInit = {}, opts: FetchOptions): Promise<ProviderResponse> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as { name?: string } | null)?.name === "AbortError";
      const err = new IntegrationError(aborted ? "timeout" : "network");
      if (!opts.idempotent || attempt >= maxAttempts) throw err;
      await sleep(backoff(attempt));
      continue;
    }
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 300) return { status: res.status, json: await readBody(res), headers: res.headers };
    if (res.status === 429 && attempt < maxAttempts) { await sleep(retryAfterMs(res, attempt)); continue; }
    if (res.status >= 500 && opts.idempotent && attempt < maxAttempts) { await sleep(backoff(attempt)); continue; }
    const body = await readBody(res);
    throw new IntegrationError(classifyStatus(res.status), res.status, providerCode(body));
  }
}
