// Server-side configuration. Reads process.env, so import it from server code only.
// Secrets (GEMINI_API_KEY, SUPABASE_SERVICE_ROLE_KEY) are never NEXT_PUBLIC_ and never sent to the browser.

export interface ExtractionLimits {
  batchMaxFiles: number; // files per batch (hard ceiling 100, also enforced in SQL)
  monthlyLimit: number; // extraction jobs per firm per UTC month
  perMinuteLimit: number; // jobs queued per firm per minute
  maxConcurrent: number; // jobs processing at the same time per firm
  maxRunsPerInvoice: number; // total runs (first run + manual retries) per invoice
  uploadsPerDay: number; // uploaded files per firm per rolling 24 h
  staleSeconds: number; // a 'processing' job older than this is treated as crashed
  maxPdfPages: number;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  inputPricePerMTok: number; // USD per 1M input tokens
  outputPricePerMTok: number; // USD per 1M output tokens (thinking tokens are billed as output)
  timeoutMs: number; // per provider call
  deadlineMs: number; // total budget for one run; keep below the route's maxDuration
  maxAttempts: number; // provider calls per run
  maxOutputTokens: number;
  verify: boolean; // second AI reading of every invoice, compared with the first (EXTRACTION_VERIFY=off to disable)
  audit?: boolean; // third, blind row-by-row audit reading; the three readings are voted field by field (EXTRACTION_AUDIT=off to disable)
  totalCheck?: boolean; // blind key-figures reading (totals block, e-invoice identifiers, amount in words) (EXTRACTION_TOTAL_CHECK=off to disable)
  partiesCheck?: boolean; // blind parties reading (supplier / buyer name, GSTIN, PAN, state, every printed GSTIN) (EXTRACTION_PARTIES_CHECK=off to disable)
  highResolution?: boolean; // zoom: every reading is requested at high media resolution (EXTRACTION_HIGH_RES=off to disable)
  sourceVerify?: boolean; // targeted re-read of only the suspicious values against the original file (source-verify.ts) (EXTRACTION_SOURCE_VERIFY=off to disable; also needs verify on)
  partiesRetries?: number; // extra parties readings when a GSTIN is still not verified after the vote (EXTRACTION_PARTIES_RETRIES, 0 to 3, default 1)
}

export interface CheckConfig {
  lowConfidence: number; // confidence below this is flagged
  tolerancePaise: number; // arithmetic tolerance (100 = INR 1.00)
  lineFix?: boolean; // correct a misread quantity / unit price / taxable value when the line maths and independent evidence prove it (EXTRACTION_LINE_FIX=off to disable)
  lineFixMaxConfidence?: number; // a value the model read with at least this confidence is only corrected when all three witnesses agree (default 0.95)
  dedupeRows?: boolean; // remove item rows read twice only when the invoice taxable total proves it (EXTRACTION_DEDUPE_ROWS=off to disable)
  forex?: boolean; // fetch the exchange rate of the invoice date for foreign currency invoices that print none (EXTRACTION_FOREX=off to disable)
}

// Foreign exchange rate lookup (fx-rates.ts). Free public sources, no API key.
export interface FxConfig {
  enabled: boolean;
  timeoutMs: number; // per HTTP call
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  return Math.round(num(env, key, fallback, min, max));
}

// Defaults checked against Google's Gemini deprecation page and public price lists on 11 Oct 2026.
// Re-check https://ai.google.dev/gemini-api/docs/pricing before going live. Override through env.
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_INPUT_PRICE = 0.3;
export const DEFAULT_OUTPUT_PRICE = 2.5;

export function getLimits(env: Env = process.env): ExtractionLimits {
  return {
    batchMaxFiles: int(env, "EXTRACTION_BATCH_MAX_FILES", 10, 1, 100),
    monthlyLimit: int(env, "EXTRACTION_MONTHLY_LIMIT", 200, 0, 1_000_000),
    perMinuteLimit: int(env, "EXTRACTION_PER_MINUTE_LIMIT", 20, 1, 10_000),
    maxConcurrent: int(env, "EXTRACTION_MAX_CONCURRENT", 3, 1, 50),
    maxRunsPerInvoice: int(env, "EXTRACTION_MAX_RUNS_PER_INVOICE", 3, 1, 20),
    uploadsPerDay: int(env, "EXTRACTION_UPLOADS_PER_DAY", 300, 1, 100_000),
    staleSeconds: int(env, "EXTRACTION_STALE_SECONDS", 240, 60, 3600),
    maxPdfPages: int(env, "EXTRACTION_MAX_PDF_PAGES", 10, 1, 100),
  };
}

// A layer is ON unless its variable is set to off / false / 0 / no.
function switchedOn(raw: string | undefined): boolean {
  return !["off", "false", "0", "no"].includes((raw ?? "").trim().toLowerCase());
}

// Returns null when the API key is missing, so routes can answer 503 before touching any job.
export function getGeminiConfig(env: Env = process.env): GeminiConfig | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
    inputPricePerMTok: num(env, "GEMINI_INPUT_PRICE_PER_MTOK", DEFAULT_INPUT_PRICE, 0, 1000),
    outputPricePerMTok: num(env, "GEMINI_OUTPUT_PRICE_PER_MTOK", DEFAULT_OUTPUT_PRICE, 0, 1000),
    timeoutMs: int(env, "GEMINI_TIMEOUT_MS", 40_000, 5_000, 120_000),
    deadlineMs: int(env, "EXTRACTION_DEADLINE_MS", 150_000, 10_000, 280_000),
    maxAttempts: int(env, "EXTRACTION_MAX_ATTEMPTS", 3, 1, 5),
    maxOutputTokens: int(env, "GEMINI_MAX_OUTPUT_TOKENS", 32_768, 1_024, 65_536),
    verify: switchedOn(env.EXTRACTION_VERIFY),
    audit: switchedOn(env.EXTRACTION_AUDIT),
    totalCheck: switchedOn(env.EXTRACTION_TOTAL_CHECK),
    partiesCheck: switchedOn(env.EXTRACTION_PARTIES_CHECK),
    highResolution: switchedOn(env.EXTRACTION_HIGH_RES),
    sourceVerify: switchedOn(env.EXTRACTION_SOURCE_VERIFY),
    partiesRetries: int(env, "EXTRACTION_PARTIES_RETRIES", 1, 0, 3),
  };
}

export function getCheckConfig(env: Env = process.env): CheckConfig {
  return {
    lowConfidence: num(env, "EXTRACTION_LOW_CONFIDENCE", 0.8, 0, 1),
    tolerancePaise: int(env, "EXTRACTION_TOLERANCE_PAISE", 100, 0, 100_000),
    lineFix: switchedOn(env.EXTRACTION_LINE_FIX),
    lineFixMaxConfidence: num(env, "EXTRACTION_LINE_FIX_MAX_CONFIDENCE", 0.95, 0, 1),
    dedupeRows: switchedOn(env.EXTRACTION_DEDUPE_ROWS),
    forex: switchedOn(env.EXTRACTION_FOREX),
  };
}

export function getFxConfig(env: Env = process.env): FxConfig {
  return { enabled: switchedOn(env.EXTRACTION_FOREX), timeoutMs: int(env, "FX_TIMEOUT_MS", 2_500, 500, 10_000) };
}
