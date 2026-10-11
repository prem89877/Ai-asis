// XLSX writer without dependencies. Produces real Excel cells:
//  - dates are date serials with a date format, not text
//  - amounts are numbers with #,##0.00; GSTIN, invoice numbers, HSN and ids are text cells (no lost zeros, no 1E+10)
//  - header row is styled, frozen and filterable
// Strings are written as inline strings, so a value such as "=SUM(A1)" is stored as text and never evaluated.
import type { CellValue, ColumnKind } from "./columns.ts";
import type { Table } from "./build.ts";
import type { DateFormat } from "./csv.ts";
import { zip } from "./zip.ts";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const MAX_ROWS = 1_048_575; // Excel allows 1,048,576 rows including the header
const MAX_CELL_CHARS = 32_000; // Excel limit is 32,767
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export function colName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function escapeXml(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Excel date serial for a calendar date (1900 system, valid for dates after 1 Mar 1900).
export function dateSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms)) return null;
  return ms / 86_400_000 + 25_569;
}

export function dateTimeSerial(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (t + IST_OFFSET_MS) / 86_400_000 + 25_569; // shown in IST
}

const STYLE: Record<ColumnKind | "header", number> = {
  header: 1, text: 2, date: 3, datetime: 4, money: 5, qty: 6, price: 7, rate: 8, integer: 9,
};

function stylesXml(fmt: DateFormat): string {
  const dateCode = fmt === "dmy" ? "dd/mm/yyyy" : "yyyy-mm-dd";
  const dtCode = fmt === "dmy" ? "dd/mm/yyyy hh:mm" : "yyyy-mm-dd hh:mm";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="${NS}">` +
    `<numFmts count="4">` +
    `<numFmt numFmtId="164" formatCode="${dateCode}"/>` +
    `<numFmt numFmtId="165" formatCode="${dtCode}"/>` +
    `<numFmt numFmtId="168" formatCode="#,##0.00##"/>` +
    `<numFmt numFmtId="169" formatCode="General&quot;%&quot;"/>` +
    `</numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="10">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>` +
    `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>` +
    `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

function strCell(ref: string, style: number, text: string): string {
  const t = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(t)}</t></is></c>`;
}

function cellXml(ref: string, v: CellValue, kind: ColumnKind): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return `<c r="${ref}" s="${STYLE[kind]}"><v>${String(v)}</v></c>`;
  }
  if (kind === "date") {
    const n = dateSerial(v);
    return n === null ? strCell(ref, STYLE.text, v) : `<c r="${ref}" s="${STYLE.date}"><v>${n}</v></c>`;
  }
  if (kind === "datetime") {
    const n = dateTimeSerial(v);
    return n === null ? strCell(ref, STYLE.text, v) : `<c r="${ref}" s="${STYLE.datetime}"><v>${n}</v></c>`;
  }
  return strCell(ref, STYLE.text, v);
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let n = base;
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

function sheetXml(t: Table): string {
  if (t.rows.length > MAX_ROWS) throw new Error("too_many_rows");
  const cols = t.headers.length;
  const lastRow = t.rows.length + 1;
  let xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}">` +
    `<dimension ref="A1:${colName(Math.max(cols, 1) - 1)}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${t.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData><row r="1" ht="30" customHeight="1">${t.headers.map((h, i) => strCell(`${colName(i)}1`, STYLE.header, h)).join("")}</row>`;
  t.rows.forEach((row, r) => {
    const n = r + 2;
    let cells = "";
    for (let c = 0; c < cols; c++) cells += cellXml(`${colName(c)}${n}`, row[c] ?? null, t.kinds[c]);
    xml += `<row r="${n}">${cells}</row>`;
  });
  xml += `</sheetData>`;
  if (cols > 0) xml += `<autoFilter ref="A1:${colName(cols - 1)}${lastRow}"/>`;
  return `${xml}</worksheet>`;
}

export function toXlsx(tables: Table[], fmt: DateFormat, now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const used = new Set<string>();
  const names = tables.map((t) => safeSheetName(t.name, used));
  const entries = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
          names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          `</sheets></workbook>`
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
          `<Relationship Id="rId${tables.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      ),
    },
    { name: "xl/styles.xml", data: enc.encode(stylesXml(fmt)) },
    ...tables.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(t)) })),
  ];
  return zip(entries, now);
}
