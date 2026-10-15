import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildTables, sortInvoices } from "../lib/export/build.ts";
import { toCsv, formatNumber, formatDate, formatDateTime, guardFormula } from "../lib/export/csv.ts";
import { toXlsx, colName, dateSerial, escapeXml } from "../lib/export/xlsx.ts";
import { crc32 } from "../lib/export/zip.ts";
import { INVOICE_COLUMNS, ITEM_COLUMNS, DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS, validateColumnKeys, flagsSummary } from "../lib/export/columns.ts";
import { getAvailableProfile, EXPORT_PROFILES } from "../lib/export/profiles.ts";

const inv = (o = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00",
  vendor_name: "Acme, Traders \"Pvt\"", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "Beta", buyer_gstin: null, invoice_number: "0012",
  invoice_date: "2026-09-15", place_of_supply: "Maharashtra (27)", currency: "INR", document_type: "tax_invoice", taxable_amount: 1000,
  discount_amount: null, cgst_amount: 90, sgst_amount: 90, igst_amount: null, cess_amount: null, tax_total: 180, total_amount: 1180,
  confidence: 0.9, review_flags: [], verified_at: "2026-10-11T05:00:00+00:00", ...o,
});
const it = (o = {}) => ({ invoice_id: "11111111-1111-4111-8111-111111111111", position: 1, description: "Widget", hsn_code: "08471", quantity: 2.5, unit: "Nos", unit_price: 400, discount_amount: null, taxable_amount: 1000, gst_rate: 18, gst_amount: 180, line_total: 1180, ...o });

function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csz = dv.getUint32(p + 20, true), usz = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(lo + 26, true), lel = dv.getUint16(lo + 28, true);
    const raw = bytes.subarray(lo + 30 + lnl + lel, lo + 30 + lnl + lel + csz);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    assert.equal(data.length, usz);
    assert.equal(crc32(data), crc);
    out[name] = new TextDecoder().decode(data);
    p += 46 + nl + el + cl;
  }
  return out;
}

test("crc32 known value", () => assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926));
test("column names and escaping", () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  assert.equal(escapeXml("a<b>&\"\u0001"), "a&lt;b&gt;&amp;&quot;");
  assert.equal(dateSerial("2026-09-15"), 46280);
  assert.equal(dateSerial("1900-03-01"), 61);
});

test("csv: header, BOM, CRLF, quoting, number and date formats, no thousands separators", () => {
  const [t] = buildTables([inv()], new Map(), { format: "csv", columns: ["invoice_number", "invoice_date", "vendor_name", "taxable_amount", "cgst_amount", "sgst_amount", "igst_amount", "total_amount"], itemColumns: [], includeItems: false });
  const bytes = toCsv(t, "iso");
  assert.deepEqual(Array.from(bytes.subarray(0, 3)), [0xef, 0xbb, 0xbf]); // UTF-8 BOM
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const lines = text.slice(1).split("\r\n");
  assert.equal(lines[0], "Invoice No,Invoice Date,Supplier Name,Taxable Value,CGST,SGST,IGST,Invoice Total");
  assert.equal(lines[1], '0012,2026-09-15,"Acme, Traders ""Pvt""",1000.00,90.00,90.00,,1180.00');
  const dmy = new TextDecoder().decode(toCsv(t, "dmy"));
  assert.ok(dmy.includes("15/09/2026"));
});

test("csv: formula injection is neutralised for text only", () => {
  assert.equal(guardFormula("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(guardFormula("+91 99"), "'+91 99");
  assert.equal(guardFormula("@x"), "'@x");
  assert.equal(guardFormula("INV-1"), "INV-1");
  const [t] = buildTables([inv({ vendor_name: "=cmd|' /C calc'!A0", total_amount: -50.5 })], new Map(), { format: "csv", columns: ["vendor_name", "total_amount"], itemColumns: [], includeItems: false });
  const text = new TextDecoder().decode(toCsv(t, "iso"));
  assert.ok(text.includes("'=cmd"));
  assert.ok(text.includes(",-50.50"));
});

test("number and time formatting", () => {
  assert.equal(formatNumber(1234567.5, "money"), "1234567.50");
  assert.equal(formatNumber(2.5, "qty"), "2.5");
  assert.equal(formatNumber(2, "qty"), "2");
  assert.equal(formatNumber(12.3456, "price"), "12.3456");
  assert.equal(formatNumber(400, "price"), "400.00");
  assert.equal(formatNumber(18, "rate"), "18");
  assert.equal(formatNumber(-0.001, "money"), "0.00");
  assert.equal(formatDate("2026-09-15", "dmy"), "15/09/2026");
  assert.equal(formatDateTime("2026-10-11T20:00:00+00:00", "iso"), "2026-10-12 01:30"); // IST rolls to next day
});

test("csv with items is flattened: one row per item, invoices without items keep one row", () => {
  const a = inv();
  const b = inv({ id: "22222222-2222-4222-8222-222222222222", invoice_number: "0013" });
  const items = new Map([[a.id, [it(), it({ position: 2, description: "Gadget" })]]]);
  const [t] = buildTables([a, b], items, { format: "csv", columns: ["invoice_number"], itemColumns: ["inv_invoice_number", "position", "description", "hsn_code", "gst_rate"], includeItems: true });
  assert.deepEqual(t.headers, ["Invoice No", "Item: Item No", "Item: Description", "Item: HSN/SAC", "Item: GST Rate %"]);
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows[2], ["0013", null, null, null, null]);
});

test("xlsx: valid package, real dates/numbers, text for ids, items on a second sheet", () => {
  const a = inv();
  const tables = buildTables([a], new Map([[a.id, [it()]]]), { format: "xlsx", columns: [...DEFAULT_COLUMNS, "id", "created_at"], itemColumns: [...DEFAULT_ITEM_COLUMNS], includeItems: true });
  assert.equal(tables.length, 2);
  const files = unzip(toXlsx(tables, "dmy", new Date("2026-10-11T00:00:00Z")));
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  assert.ok(files["xl/workbook.xml"].includes('name="Line items"'));
  assert.ok(files["xl/styles.xml"].includes("dd/mm/yyyy"));
  const s1 = files["xl/worksheets/sheet1.xml"];
  assert.ok(s1.includes("<v>46280</v>")); // invoice date as a date serial
  assert.ok(s1.includes(">0012</t>")); // invoice number keeps its leading zeros (text cell)
  assert.ok(s1.includes("<autoFilter"));
  assert.ok(s1.includes('state="frozen"'));
  const s2 = files["xl/worksheets/sheet2.xml"];
  assert.ok(s2.includes(">08471</t>")); // HSN kept as text
  assert.ok(s2.includes("<v>2.5</v>"));
});

test("xlsx: a value that looks like a formula is stored as text", () => {
  const [t] = buildTables([inv({ vendor_name: "=1+1" })], new Map(), { format: "xlsx", columns: ["vendor_name"], itemColumns: [], includeItems: false });
  const files = unzip(toXlsx([t], "iso"));
  assert.ok(files["xl/worksheets/sheet1.xml"].includes('t="inlineStr"'));
  assert.ok(!files["xl/worksheets/sheet1.xml"].includes("<f>"));
});

test("columns: registry keys unique, validation keeps order and rejects unknown/duplicate", () => {
  for (const reg of [INVOICE_COLUMNS, ITEM_COLUMNS]) assert.equal(new Set(reg.map((c) => c.key)).size, reg.length);
  for (const k of DEFAULT_COLUMNS) assert.ok(INVOICE_COLUMNS.some((c) => c.key === k));
  for (const k of DEFAULT_ITEM_COLUMNS) assert.ok(ITEM_COLUMNS.some((c) => c.key === k));
  assert.deepEqual(validateColumnKeys(["total_amount", "invoice_number"], INVOICE_COLUMNS, "c"), { ok: true, keys: ["total_amount", "invoice_number"] });
  assert.equal(validateColumnKeys(["nope"], INVOICE_COLUMNS, "c").ok, false);
  assert.equal(validateColumnKeys(["id", "id"], INVOICE_COLUMNS, "c").ok, false);
  assert.equal(validateColumnKeys([], INVOICE_COLUMNS, "c").ok, false);
  assert.equal(validateColumnKeys([], INVOICE_COLUMNS, "c", true).ok, true);
  assert.equal(validateColumnKeys("id", INVOICE_COLUMNS, "c").ok, false);
  assert.equal(validateColumnKeys(Array.from({ length: 41 }, (_, i) => `k${i}`), INVOICE_COLUMNS, "c").ok, false);
});

test("column order is respected", () => {
  const [t] = buildTables([inv()], new Map(), { format: "csv", columns: ["total_amount", "invoice_number"], itemColumns: [], includeItems: false });
  assert.deepEqual(t.headers, ["Invoice Total", "Invoice No"]);
});

test("GST amounts are separate columns", () => {
  const labels = INVOICE_COLUMNS.map((c) => c.label);
  for (const l of ["CGST", "SGST", "UTGST", "IGST", "Cess", "Total Tax", "Taxable Value"]) assert.ok(labels.includes(l));
});

test("sorting is by date, then number (natural), then upload time; flags summarised by severity", () => {
  const s = sortInvoices([inv({ invoice_number: "INV-10" }), inv({ invoice_number: "INV-2" }), inv({ invoice_date: null, invoice_number: "A" })]);
  assert.deepEqual(s.map((x) => x.invoice_number), ["INV-2", "INV-10", "A"]);
  assert.equal(flagsSummary([]), null);
  const text = flagsSummary([{ code: "a", severity: "info", message: "i" }, { code: "b", severity: "error", message: "e", itemPosition: 2 }]);
  assert.equal(text, "[error] Item 2: e | [info] i");
});

test("only the standard profile is available; Tally is planned, not available", () => {
  assert.ok(getAvailableProfile("standard"));
  assert.equal(getAvailableProfile("tally"), null);
  assert.equal(getAvailableProfile("../x"), null);
  assert.equal(EXPORT_PROFILES.find((p) => p.id === "tally").status, "planned");
});
