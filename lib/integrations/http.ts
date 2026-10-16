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
  /** Absolute time (Date.now() ms) by which the whole call, retries and waits included, must be finished. Lets a route that has a
   *  maxDuration stop cleanly with a "timeout" / "rate_limited" error instead of being killed by the platform half-way through a sync. */
  deadlineAt?: number;
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

// The caller keeps its timeout timer running while this reads, so a response whose headers arrive and whose body then hangs is
// aborted too. A body that cannot be read (aborted, cut off, not JSON) is "no JSON": the status code alone decides what happens next.
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
  const left = () => (opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - Date.now());
  // Waiting is only allowed when the deadline still leaves room for the wait AND a real attempt afterwards.
  const canWait = (ms: number) => left() > ms + 1_000;

  for (let attempt = 1; ; attempt++) {
    const budget = Math.min(opts.timeoutMs ?? 25_000, left());
    if (budget <= 0) throw new IntegrationError("timeout");
    const controller = new AbortController();
    // One timer covers the request AND the reading of the body; it is cleared only when the body is done.
    const timer = setTimeout(() => controller.abort(), budget);
    let res: Response;
    let body: any;
    try {
      try {
        res = await doFetch(url, { ...init, signal: controller.signal });
      } catch (e) {
        const aborted = (e as { name?: string } | null)?.name === "AbortError";
        const err = new IntegrationError(aborted ? "timeout" : "network");
        if (!opts.idempotent || attempt >= maxAttempts) throw err;
        const wait = backoff(attempt);
        if (!canWait(wait)) throw err;
        await sleep(wait);
        continue;
      }
      body = await readBody(res);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, json: body, headers: res.headers };
    if (res.status === 429 && attempt < maxAttempts) {
      const wait = retryAfterMs(res, attempt);
      if (canWait(wait)) { await sleep(wait); continue; }
    } else if (res.status >= 500 && opts.idempotent && attempt < maxAttempts) {
      const wait = backoff(attempt);
      if (canWait(wait)) { await sleep(wait); continue; }
    }
    throw new IntegrationError(classifyStatus(res.status), res.status, providerCode(body));
  }
}
