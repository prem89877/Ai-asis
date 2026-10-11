// CSV serializer. UTF-8 with a byte-order mark (so Excel reads rupee signs and Indian-language names correctly),
// CRLF line endings, numbers as plain decimals (no thousands separators), text protected against spreadsheet formulas.
import type { CellValue, ColumnKind } from "./columns.ts";
import type { Table } from "./build.ts";

export type DateFormat = "iso" | "dmy";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function formatDate(iso: string, fmt: DateFormat): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return fmt === "dmy" ? `${m[3]}/${m[2]}/${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

// Timestamps are shown in Indian Standard Time (UTC+05:30, no daylight saving).
export function formatDateTime(iso: string, fmt: DateFormat): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + IST_OFFSET_MS).toISOString(); // shifted: read the UTC fields
  const date = formatDate(d.slice(0, 10), fmt);
  return `${date} ${d.slice(11, 16)}`;
}

function trimDecimals(n: number, minDp: number, maxDp: number): string {
  let s = n.toFixed(maxDp);
  if (s.includes(".")) {
    const [i, f] = s.split(".");
    let frac = f;
    while (frac.length > minDp && frac.endsWith("0")) frac = frac.slice(0, -1);
    s = frac.length ? `${i}.${frac}` : i;
  }
  return s === "-0" || s === "-0.00" ? s.slice(1) : s;
}

export function formatNumber(n: number, kind: ColumnKind): string {
  switch (kind) {
    case "money": return trimDecimals(n, 2, 2);
    case "qty": return trimDecimals(n, 0, 3);
    case "price": return trimDecimals(n, 2, 4);
    case "rate": return trimDecimals(n, 0, 2);
    default: return String(Math.round(n));
  }
}

// A text cell that starts with = + - @ tab or CR can be run as a formula by Excel/Sheets. Prefix an apostrophe.
export function guardFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function field(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function cellToCsv(v: CellValue, kind: ColumnKind, fmt: DateFormat): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return formatNumber(v, kind);
  switch (kind) {
    case "date": return formatDate(v, fmt);
    case "datetime": return formatDateTime(v, fmt);
    default: return field(guardFormula(v));
  }
}

export function toCsv(table: Table, fmt: DateFormat): Uint8Array {
  const lines = [table.headers.map((h) => field(guardFormula(h))).join(",")];
  for (const row of table.rows) lines.push(row.map((v, i) => cellToCsv(v, table.kinds[i], fmt)).join(","));
  const text = `\uFEFF${lines.join("\r\n")}\r\n`;
  return new TextEncoder().encode(text);
}
