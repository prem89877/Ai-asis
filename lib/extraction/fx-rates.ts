// Historical exchange rate lookup: INR per 1 unit of a foreign currency, on the INVOICE DATE.
// Pure logic. The network call (fetchImpl) and the cache are injected, so everything here is testable without internet.
//
// Sources (all free, no API key, historical by date):
//   1. Frankfurter  (api.frankfurter.dev)         ECB reference rates, ~30 major currencies (USD, EUR, GBP, JPY, AUD, ...),
//                                                  weekends / holidays automatically return the last working day.
//   2. currency-api (fawazahmed0, jsDelivr CDN)   200+ currencies, one snapshot per day. Used when Frankfurter has no answer.
//   3. currency-api (Cloudflare Pages mirror)     second copy of source 2, used when the CDN is down.
//
// IMPORTANT, said plainly: RBI / FBIL publish the official INR reference rate, but neither has a free public JSON API.
// The rates above are market reference rates (ECB / daily mid-market). They are normally within about 1 percent of the RBI
// reference rate, never exactly equal. The result therefore carries a `sourceLabel` and the invoice is flagged as
// "auto-fetched", so a person can confirm it against the rate their books use (see forex.ts).

export interface FxRate {
  currency: string; // invoice currency, upper case
  rate: number; // INR per 1 unit of `currency`
  requestedDate: string; // invoice date (YYYY-MM-DD)
  rateDate: string; // date the rate was actually published for (on or before requestedDate)
  source: "frankfurter" | "currency-api" | "currency-api-mirror";
  sourceLabel: string;
}

export type FxFailure = "unsupported_currency" | "bad_date" | "future_date" | "too_old" | "unavailable" | "implausible";
export type FxResult = { ok: true; rate: FxRate } | { ok: false; reason: FxFailure };
export type FxLookup = (currency: string, date: string) => Promise<FxResult>;

// Optional persistent cache (Supabase table fx_rates). Historical rates never change, so a hit is final.
export interface FxCache {
  get(currency: string, date: string): Promise<FxRate | null>;
  set(rate: FxRate): Promise<void>;
}

export interface FxOptions {
  fetchImpl?: typeof fetch;
  cache?: FxCache | null;
  timeoutMs?: number; // per HTTP call
  now?: () => number;
  maxLookbackDays?: number; // a rate older than this (before the invoice date) is not accepted
}

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_LOOKBACK_DAYS = 7;
const MIN_DATE = "1999-01-04"; // first ECB reference rate
const MAX_RATE = 1_000_000;

const SOURCE_LABELS: Record<FxRate["source"], string> = {
  frankfurter: "ECB reference rate via Frankfurter",
  "currency-api": "daily market rate via currency-api",
  "currency-api-mirror": "daily market rate via currency-api (mirror)",
};

// Rough sanity band for INR per 1 unit, so a wrong-unit or garbage answer is never used (it would silently ruin a total).
// Currencies not listed here only get the generic 0 < rate < 1,000,000 check.
const PLAUSIBLE_INR: Record<string, [number, number]> = {
  USD: [30, 200], EUR: [30, 250], GBP: [40, 300], AUD: [20, 150], CAD: [20, 150], SGD: [20, 150], CHF: [30, 300],
  AED: [8, 50], JPY: [0.15, 3], CNY: [4, 40], HKD: [4, 40], NZD: [20, 150], SAR: [8, 50],
};

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function plausibleRate(currency: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0 || rate >= MAX_RATE) return false;
  const band = PLAUSIBLE_INR[currency];
  return band ? rate >= band[0] && rate <= band[1] : true;
}

interface Hit { rate: number; date: string }
type Fetcher = (currency: string, date: string, get: (url: string) => Promise<unknown>) => Promise<Hit | null>;

const fetchFrankfurter: Fetcher = async (cur, date, get) => {
  const body = (await get(`https://api.frankfurter.dev/v1/${date}?base=${cur}&symbols=INR`)) as { date?: unknown; rates?: { INR?: unknown } } | null;
  const r = body?.rates?.INR;
  if (typeof r !== "number" || typeof body?.date !== "string") return null;
  return { rate: r, date: body.date };
};

const currencyApi = (host: (date: string) => string): Fetcher => async (cur, date, get) => {
  const code = cur.toLowerCase();
  const body = (await get(`${host(date)}/v1/currencies/${code}.json`)) as Record<string, unknown> | null;
  const table = body?.[code] as { inr?: unknown } | undefined;
  const r = table?.inr;
  if (typeof r !== "number") return null;
  const d = typeof body?.date === "string" ? (body.date as string) : date;
  return { rate: r, date: d };
};

const SOURCES: { id: FxRate["source"]; run: Fetcher }[] = [
  { id: "frankfurter", run: fetchFrankfurter },
  { id: "currency-api", run: currencyApi((d) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}`) },
  { id: "currency-api-mirror", run: currencyApi((d) => `https://${d}.currency-api.pages.dev`) },
];

export function createFxLookup(options: FxOptions = {}): FxLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const lookback = options.maxLookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const memory = new Map<string, FxRate>();

  const get = async (url: string): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return async (currencyIn, date) => {
    const currency = (currencyIn ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency === "INR") return { ok: false, reason: "unsupported_currency" };
    if (!isIsoDate(date)) return { ok: false, reason: "bad_date" };
    const today = new Date(now() + 24 * 3_600_000).toISOString().slice(0, 10); // one day of slack for time zones
    if (date > today) return { ok: false, reason: "future_date" };
    if (date < MIN_DATE) return { ok: false, reason: "too_old" };

    const key = `${currency}|${date}`;
    const mem = memory.get(key);
    if (mem) return { ok: true, rate: mem };
    if (options.cache) {
      try {
        const hit = await options.cache.get(currency, date);
        if (hit && plausibleRate(currency, hit.rate)) {
          memory.set(key, hit);
          return { ok: true, rate: hit };
        }
      } catch {
        // a broken cache must never stop the lookup
      }
    }

    let rejected = false;
    for (const src of SOURCES) {
      let hit: Hit | null = null;
      try {
        hit = await src.run(currency, date, get);
      } catch {
        hit = null;
      }
      if (!hit) continue;
      // The answer must be for the invoice date or a few days before it (weekend / bank holiday). A later date is wrong.
      const age = isIsoDate(hit.date) ? daysBetween(hit.date, date) : NaN;
      if (!Number.isFinite(age) || age < 0 || age > lookback || !plausibleRate(currency, hit.rate)) {
        rejected = true;
        continue;
      }
      const rate: FxRate = {
        currency, rate: Math.round(hit.rate * 1e6) / 1e6, requestedDate: date, rateDate: hit.date,
        source: src.id, sourceLabel: SOURCE_LABELS[src.id],
      };
      memory.set(key, rate);
      if (options.cache) {
        try {
          await options.cache.set(rate);
        } catch {
          // ignore: the rate is still used for this invoice
        }
      }
      return { ok: true, rate };
    }
    return { ok: false, reason: rejected ? "implausible" : "unavailable" };
  };
}
