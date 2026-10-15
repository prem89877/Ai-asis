// GST portal verification and vendor fraud warnings for the SUPPLIER GSTIN.
//
// The GST portal's own "Search Taxpayer" page has no public API (it is protected by a captcha, and scraping it is not allowed),
// so the lookup goes through a GSTIN lookup service that reads the GSP network. The default adapter is gstinapi.in
// (GET <base>/v1/gstin/<GSTIN>, header x-api-key; free sandbox GSTIN 00AAAAA0000A1ZT; about 100 free lookups on sign-up).
// Any other service can be used by writing another adapter that returns a GstRecord (see parseGstinApi) and passing it as `lookup`.
//
// What it answers, for the supplier GSTIN and the INVOICE DATE:
//   - Is the GSTIN known to the GST system at all?
//   - Active / Cancelled / Suspended, and was it ACTIVE ON THE INVOICE DATE (registration date <= invoice date, and no
//     cancellation on or before the invoice date)? An invoice dated after cancellation, or before registration, is the classic
//     fake-vendor pattern: the buyer cannot claim input tax credit on it.
//   - Does the registered legal / trade name match the supplier name on the invoice?
//   - Composition dealers may not charge GST: a composition supplier charging tax is flagged.
//
// It only ADDS flags and a short summary. It never changes an extracted value. If the service is down, slow, not configured or out
// of credits, a single info note says so and extraction is not blocked.
import { checkGstin } from "./normalize.ts";
import { namesCompatible } from "./party-check.ts";
import type { ReviewFlag, StoredExtracted } from "./types.ts";

export type PortalStatus = "active" | "cancelled" | "suspended" | "other";

export interface GstRecord {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  status: PortalStatus;
  statusText: string; // as the service printed it
  taxpayerType: string | null; // Regular, Composition, SEZ ...
  registrationDate: string | null; // YYYY-MM-DD
  cancellationDate: string | null; // YYYY-MM-DD
  blocked: boolean;
}

export type LookupResult =
  | { ok: true; record: GstRecord }
  | { ok: false; code: "not_found" | "no_credits" | "rate_limited" | "unavailable" | "timeout" | "bad_response" };

export type GstLookup = (gstin: string, opts: { timeoutMs: number }) => Promise<LookupResult>;

// ---- Adapter: gstinapi.in ------------------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && ISO_DATE.test(v.trim()) ? v.trim() : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function portalStatusOf(text: string): PortalStatus {
  const t = text.trim().toLowerCase();
  if (t === "active") return "active";
  if (t.startsWith("cancel")) return "cancelled";
  if (t.startsWith("suspend")) return "suspended";
  return "other";
}

// Turns the JSON body of a 200 answer into a GstRecord; null when the shape is not what we expect.
export function parseGstinApi(body: unknown, gstin: string): GstRecord | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { success?: unknown; data?: unknown };
  if (b.success !== true || typeof b.data !== "object" || b.data === null) return null;
  const d = b.data as Record<string, unknown>;
  const statusText = textOrNull(d.status);
  if (!statusText) return null;
  return {
    gstin,
    legalName: textOrNull(d.legal_name),
    tradeName: textOrNull(d.trade_name),
    status: portalStatusOf(statusText),
    statusText,
    taxpayerType: textOrNull(d.taxpayer_type),
    registrationDate: isoOrNull(d.registration_date),
    cancellationDate: isoOrNull(d.cancellation_date),
    blocked: typeof d.block_status === "string" && d.block_status.trim().toUpperCase() === "B",
  };
}

export interface GstPortalConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  cacheMinutes: number;
}

type Env = Record<string, string | undefined>;

// null when no API key is set: the check is then simply not run.
export function getGstPortalConfig(env: Env = process.env): GstPortalConfig | null {
  if ((env.GST_PORTAL_CHECK ?? "").trim().toLowerCase() === "off") return null;
  const apiKey = env.GST_PORTAL_API_KEY?.trim();
  if (!apiKey) return null;
  const clamp = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(raw);
    return raw === undefined || raw.trim() === "" || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    apiKey,
    baseUrl: (env.GST_PORTAL_BASE_URL?.trim() || "https://gstinapi.in").replace(/\/+$/, ""),
    timeoutMs: clamp(env.GST_PORTAL_TIMEOUT_MS, 6_000, 1_000, 20_000),
    cacheMinutes: clamp(env.GST_PORTAL_CACHE_MINUTES, 60, 0, 1_440),
  };
}

// Small in-memory cache: the same supplier appears on many invoices of one batch, and every lookup can cost a credit.
// It lives only as long as the server instance. The status is re-read after `cacheMinutes`.
const cache = new Map<string, { at: number; record: GstRecord }>();
export function clearGstPortalCache(): void {
  cache.clear();
}

export function createGstinApiLookup(cfg: GstPortalConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): GstLookup {
  return async (gstin, { timeoutMs }) => {
    const hit = cache.get(gstin);
    if (hit && now() - hit.at < cfg.cacheMinutes * 60_000) return { ok: true, record: hit.record };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, cfg.timeoutMs));
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/v1/gstin/${encodeURIComponent(gstin)}`, { method: "GET", headers: { "x-api-key": cfg.apiKey, Accept: "application/json" }, signal: ctl.signal });
      if (res.status === 404) return { ok: false, code: "not_found" };
      if (res.status === 402) return { ok: false, code: "no_credits" };
      if (res.status === 429) return { ok: false, code: "rate_limited" };
      if (!res.ok) return { ok: false, code: "unavailable" };
      const record = parseGstinApi(await res.json().catch(() => null), gstin);
      if (!record) return { ok: false, code: "bad_response" };
      if (cfg.cacheMinutes > 0) cache.set(gstin, { at: now(), record });
      return { ok: true, record };
    } catch (e) {
      return { ok: false, code: e instanceof Error && e.name === "AbortError" ? "timeout" : "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
}

// Built once per request from the environment; null when the check is not configured.
export function createGstPortalLookup(env: Env = process.env): GstLookup | null {
  const cfg = getGstPortalConfig(env);
  return cfg ? createGstinApiLookup(cfg) : null;
}

// ---- Assessment (pure) ---------------------------------------------------------------------------------------------------

export interface PortalSummary {
  checked: boolean;
  gstin: string;
  status?: string;
  active_on_invoice_date?: boolean | null; // null = could not be decided (no invoice date, or no date on the portal record)
  registration_date?: string | null;
  cancellation_date?: string | null;
  taxpayer_type?: string | null;
  legal_name?: string | null;
  trade_name?: string | null;
  name_match?: boolean | null;
  unavailable_reason?: string;
}

const dateText = (d: string) => d;

export function assessSupplier(record: GstRecord, e: Pick<StoredExtracted, "vendor_name" | "invoice_date" | "cgst_amount" | "sgst_amount" | "utgst_amount" | "igst_amount" | "document_type">): { flags: ReviewFlag[]; summary: PortalSummary } {
  const flags: ReviewFlag[] = [];
  const inv = e.invoice_date;
  const f = "supplier_gstin";
  const base = { field: f };
  let active: boolean | null = null;

  if (inv && record.registrationDate && inv < record.registrationDate) {
    active = false;
    flags.push({
      code: "supplier_gstin_not_yet_registered", severity: "error", ...base,
      message: `Vendor fraud warning: the supplier GSTIN was registered on ${dateText(record.registrationDate)}, AFTER the invoice date ${dateText(inv)}. The supplier was not a registered taxpayer when this invoice was issued.`,
      details: { invoice_date: inv, registration_date: record.registrationDate },
    });
  }

  if (record.status === "cancelled") {
    const c = record.cancellationDate;
    if (c && inv && inv < c) {
      // Cancelled later: it was valid on the invoice date. Worth knowing, not a fraud signal.
      if (active !== false) active = true;
      flags.push({
        code: "supplier_gstin_cancelled_later", severity: "info", ...base,
        message: `The supplier GSTIN is now cancelled (from ${dateText(c)}), but it was active on the invoice date ${dateText(inv)}.`,
        details: { invoice_date: inv, cancellation_date: c },
      });
    } else if (c && inv) {
      active = false;
      flags.push({
        code: "supplier_gstin_cancelled", severity: "error", ...base,
        message: `Vendor fraud warning: the supplier GSTIN was cancelled on ${dateText(c)}, on or before the invoice date ${dateText(inv)}. Input tax credit is not available on this invoice.`,
        details: { invoice_date: inv, cancellation_date: c },
      });
    } else {
      // Cancelled, but the portal date or the invoice date is missing: the date test cannot be done.
      flags.push({
        code: "supplier_gstin_cancelled", severity: "error", ...base,
        message: `Vendor fraud warning: the supplier GSTIN is cancelled on the GST portal${c ? ` (since ${dateText(c)})` : ""}, and ${inv ? "the cancellation date is not available" : "the invoice date was not read"}, so it cannot be confirmed that it was active on the invoice date.`,
        details: { invoice_date: inv, cancellation_date: c },
      });
    }
  } else if (record.status === "suspended" || record.status === "other") {
    flags.push({
      code: "supplier_gstin_inactive", severity: "warning", ...base,
      message: `The supplier GSTIN status on the GST portal is "${record.statusText}", not Active. Confirm the registration before claiming input tax credit.`,
      details: { status: record.statusText },
    });
  } else if (record.status === "active" && active !== false) {
    active = inv && record.registrationDate ? true : null; // without the registration date the "since when" cannot be proven
  }

  if (record.blocked) {
    flags.push({ code: "supplier_gstin_blocked", severity: "warning", ...base, message: "The GST portal shows this supplier GSTIN as blocked. Check before relying on this invoice." });
  }

  // Name on the invoice against the registered legal and trade names: a mismatch is a common sign of a borrowed GSTIN.
  let nameMatch: boolean | null = null;
  const registered = [record.legalName, record.tradeName].filter((x): x is string => !!x);
  if (e.vendor_name && registered.length > 0) {
    const results = registered.map((n) => namesCompatible(e.vendor_name, n));
    nameMatch = results.some((r) => r === true) ? true : results.every((r) => r === false) ? false : null;
    if (nameMatch === false) {
      flags.push({
        code: "supplier_name_mismatch", severity: "warning", field: "supplier_name",
        message: `The supplier name on the invoice (${e.vendor_name}) does not match the name registered for this GSTIN (${registered.join(" / ")}). Check that the GSTIN belongs to this supplier.`,
        details: { invoice_name: e.vendor_name, legal_name: record.legalName, trade_name: record.tradeName },
      });
    }
  }

  // Composition taxpayers cannot collect GST from the buyer.
  const taxed = [e.cgst_amount, e.sgst_amount, e.utgst_amount, e.igst_amount].some((v) => v !== null && v > 0);
  if (record.taxpayerType && /composition/i.test(record.taxpayerType) && taxed && e.document_type === "tax_invoice") {
    flags.push({
      code: "composition_charging_tax", severity: "warning", ...base,
      message: "The supplier is registered under the Composition scheme, which does not allow charging GST on a tax invoice. Input tax credit may not be available.",
      details: { taxpayer_type: record.taxpayerType },
    });
  }

  if (record.status === "active" && !flags.some((x) => x.severity !== "info")) {
    flags.push({
      code: "supplier_gstin_verified", severity: "info", ...base,
      message: inv && active ? `The supplier GSTIN is Active on the GST portal and was active on the invoice date ${dateText(inv)}.` : "The supplier GSTIN is Active on the GST portal.",
      details: { status: record.statusText },
    });
  }

  return {
    flags,
    summary: {
      checked: true, gstin: record.gstin, status: record.statusText, active_on_invoice_date: active,
      registration_date: record.registrationDate, cancellation_date: record.cancellationDate, taxpayer_type: record.taxpayerType,
      legal_name: record.legalName, trade_name: record.tradeName, name_match: nameMatch,
    },
  };
}

const UNAVAILABLE_TEXT: Record<string, string> = {
  not_found: "", no_credits: "the lookup service has no credits left", rate_limited: "the lookup service is rate limiting requests",
  unavailable: "the lookup service could not be reached", timeout: "the lookup service took too long", bad_response: "the lookup service gave an unexpected answer",
};

// ---- Entry point -----------------------------------------------------------------------------------------------------------

export interface PortalCheck {
  flags: ReviewFlag[];
  summary: PortalSummary | null; // null = nothing to check (no usable supplier GSTIN)
  lookedUp: boolean;
}

// Looks up the saved supplier GSTIN and judges it against the invoice date. A GSTIN that fails its own format / check digit is
// not sent (it cannot exist, and a lookup may cost a credit): the GSTIN checks already flag it.
export async function checkSupplierOnPortal(lookup: GstLookup, e: StoredExtracted, opts: { timeoutMs: number }): Promise<PortalCheck> {
  const gstin = e.vendor_gstin;
  if (!gstin || !checkGstin(gstin).ok) return { flags: [], summary: null, lookedUp: false };
  const res = await lookup(gstin, opts);
  if (res.ok) return { ...assessSupplier(res.record, e), lookedUp: true };
  if (res.code === "not_found") {
    return {
      lookedUp: true,
      summary: { checked: true, gstin, status: "not found" },
      flags: [{
        code: "supplier_gstin_not_found", severity: "error", field: "supplier_gstin",
        message: "Vendor fraud warning: this supplier GSTIN has a valid format but was not found in the GST system. It may be invented or misread. Compare it with the original.",
      }],
    };
  }
  return {
    lookedUp: true,
    summary: { checked: false, gstin, unavailable_reason: res.code },
    flags: [{ code: "gst_portal_unavailable", severity: "info", field: "supplier_gstin", message: `The GST portal check could not run (${UNAVAILABLE_TEXT[res.code]}). The supplier GSTIN status was not verified.`, details: { reason: res.code } }],
  };
}
