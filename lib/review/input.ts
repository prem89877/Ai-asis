// Validation of a review request body. The browser is untrusted: every field is checked here, on the server.
// Values are never silently rounded or repaired. Anything invalid is rejected with a message naming the field.
import { MAX_ABS_AMOUNT, MAX_ABS_QUANTITY, cleanText, normalizeHsn, normalizeIsoDate } from "../extraction/normalize.ts";
import { EDITABLE_DOCUMENT_TYPES, HEADER_FIELDS, ITEM_FIELDS, MAX_ITEMS } from "./fields.ts";
import type { HeaderColumn, ItemColumn } from "./fields.ts";
import type { ReviewAction } from "./types.ts";

export type HeaderPatch = Partial<Record<HeaderColumn, string | number | null>>;
export type ItemInput = Record<ItemColumn, string | number | null>;

export interface ReviewInput {
  expectedUpdatedAt: string;
  action: ReviewAction;
  header: HeaderPatch;
  items: ItemInput[] | null;
  acknowledgeFlags: boolean;
}

export type ParseResult = { ok: true; value: ReviewInput } | { ok: false; message: string };

const ACTIONS: readonly ReviewAction[] = ["save", "verify", "unverify"];
const GSTIN_CHARS = /^[A-Z0-9]{1,15}$/;
// The exact timestamptz string the API returned, e.g. 2026-10-11T10:00:00.123456+00:00 (it is cast in SQL, so it is shape-checked).
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decimalPlaces(n: number): number {
  const s = String(n);
  if (/e/i.test(s)) return 99;
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

// Accepts a number, or a plain numeric string ("1,234.50" is fine). Empty = null (field left blank).
export function parseAmount(raw: unknown, label: string, dp: number, max: number): { ok: true; value: number | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const t = raw.replace(/[,\s]/g, "");
    if (t === "") return { ok: true, value: null };
    if (!/^-?\d+(\.\d+)?$/.test(t)) return { ok: false, message: `${label}: enter a number.` };
    n = Number(t);
  } else {
    return { ok: false, message: `${label}: enter a number.` };
  }
  if (!Number.isFinite(n)) return { ok: false, message: `${label}: enter a number.` };
  if (Math.abs(n) > max) return { ok: false, message: `${label}: the number is too large.` };
  if (decimalPlaces(n) > dp) return { ok: false, message: `${label}: use at most ${dp} decimal places.` };
  return { ok: true, value: n === 0 ? 0 : n }; // avoid -0
}

function parseText(raw: unknown, label: string, maxLength: number): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: `${label}: enter text.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) return { ok: false, message: `${label}: contains characters that are not allowed.` };
  const v = cleanText(raw);
  if (v === "") return { ok: true, value: null };
  if (v.length > maxLength) return { ok: false, message: `${label}: at most ${maxLength} characters.` };
  return { ok: true, value: v };
}

function parseHeaderValue(def: (typeof HEADER_FIELDS)[number], raw: unknown): { ok: true; value: string | number | null } | { ok: false; message: string } {
  switch (def.kind) {
    case "amount":
      return parseAmount(raw, def.label, 2, MAX_ABS_AMOUNT);
    case "gstin": {
      if (raw === null || raw === undefined) return { ok: true, value: null };
      if (typeof raw !== "string") return { ok: false, message: `${def.label}: enter text.` };
      const g = raw.replace(/\s+/g, "").toUpperCase();
      if (g === "") return { ok: true, value: null };
      // A wrong-looking GSTIN is accepted (it may be exactly what the invoice shows) and flagged for review instead.
      if (!GSTIN_CHARS.test(g)) return { ok: false, message: `${def.label}: use letters and digits only, up to 15 characters.` };
      return { ok: true, value: g };
    }
    case "date": {
      if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
      if (typeof raw !== "string") return { ok: false, message: `${def.label}: enter a date.` };
      const d = normalizeIsoDate(raw);
      return d ? { ok: true, value: d } : { ok: false, message: `${def.label}: enter a valid date.` };
    }
    case "currency": {
      if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
      if (typeof raw !== "string" || !/^[A-Za-z]{3}$/.test(raw.trim())) return { ok: false, message: `${def.label}: use a 3-letter code such as INR.` };
      return { ok: true, value: raw.trim().toUpperCase() };
    }
    case "doctype": {
      if (typeof raw !== "string" || !(EDITABLE_DOCUMENT_TYPES as readonly string[]).includes(raw)) {
        return { ok: false, message: `${def.label}: choose one of the listed types.` };
      }
      return { ok: true, value: raw };
    }
    default:
      return parseText(raw, def.label, def.maxLength ?? 200);
  }
}

export function parseReviewInput(body: unknown): ParseResult {
  if (!isRecord(body)) return { ok: false, message: "Invalid request." };
  const allowedTop = ["expectedUpdatedAt", "action", "header", "items", "acknowledgeFlags"];
  for (const k of Object.keys(body)) if (!allowedTop.includes(k)) return { ok: false, message: "Invalid request." };

  const expected = body.expectedUpdatedAt;
  if (typeof expected !== "string" || !TIMESTAMP_RE.test(expected) || Number.isNaN(Date.parse(expected))) {
    return { ok: false, message: "Invalid request." };
  }
  if (typeof body.action !== "string" || !ACTIONS.includes(body.action as ReviewAction)) return { ok: false, message: "Invalid request." };
  const action = body.action as ReviewAction;
  if (body.acknowledgeFlags !== undefined && typeof body.acknowledgeFlags !== "boolean") return { ok: false, message: "Invalid request." };

  const header: HeaderPatch = {};
  if (body.header !== undefined) {
    if (!isRecord(body.header)) return { ok: false, message: "Invalid request." };
    for (const [key, raw] of Object.entries(body.header)) {
      const def = HEADER_FIELDS.find((f) => f.column === key);
      if (!def) return { ok: false, message: "Invalid request." };
      const r = parseHeaderValue(def, raw);
      if (!r.ok) return r;
      header[def.column] = r.value;
    }
  }

  let items: ItemInput[] | null = null;
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items)) return { ok: false, message: "Invalid request." };
    if (body.items.length > MAX_ITEMS) return { ok: false, message: `At most ${MAX_ITEMS} line items are allowed.` };
    items = [];
    for (let i = 0; i < body.items.length; i++) {
      const raw = body.items[i];
      if (!isRecord(raw)) return { ok: false, message: "Invalid request." };
      for (const k of Object.keys(raw)) if (!ITEM_FIELDS.some((f) => f.key === k)) return { ok: false, message: "Invalid request." };
      const out = {} as ItemInput;
      for (const def of ITEM_FIELDS) {
        const label = `Item ${i + 1} ${def.label.toLowerCase()}`;
        const v = raw[def.key];
        if (def.kind === "amount") {
          const max = def.key === "quantity" ? MAX_ABS_QUANTITY : MAX_ABS_AMOUNT;
          const r = parseAmount(v, label, def.dp ?? 2, max);
          if (!r.ok) return r;
          if (def.key === "gst_rate" && r.value !== null && (r.value < 0 || r.value > 100)) {
            return { ok: false, message: `${label}: enter a rate from 0 to 100.` };
          }
          out[def.key] = r.value;
        } else if (def.kind === "hsn") {
          const r = parseText(v, label, 20);
          if (!r.ok) return r;
          if (r.value === null) {
            out[def.key] = null;
          } else {
            const h = normalizeHsn(r.value);
            if (h === null) return { ok: false, message: `${label}: use 4 to 8 digits.` };
            out[def.key] = h;
          }
        } else {
          const r = parseText(v, label, def.key === "description" ? 500 : 20);
          if (!r.ok) return r;
          out[def.key] = r.value;
        }
      }
      items.push(out);
    }
  }

  return { ok: true, value: { expectedUpdatedAt: expected, action, header, items, acknowledgeFlags: body.acknowledgeFlags === true } };
}
