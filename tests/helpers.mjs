// Builders for model output used across tests.
export const f = (value, confidence = 0.95) => ({ status: "present", value, confidence });
export const missing = () => ({ status: "missing", value: null, confidence: 0.9 });
export const unreadable = () => ({ status: "unreadable", value: null, confidence: 0.2 });

export function item(over = {}) {
  return {
    description: f("Widget"), hsn_sac: f("8471"), unit: f("Nos"),
    quantity: f(2), unit_price: f(500), discount: missing(), taxable_value: f(1000),
    gst_rate: f(18), tax_amount: f(180), line_total: f(1180), ...over,
  };
}

// A consistent intra-state invoice: 1000 taxable + 90 CGST + 90 SGST = 1180.
export function model(over = {}) {
  return {
    document_type: "tax_invoice",
    currency: f("INR"),
    supplier_name: f("Acme Traders"), supplier_gstin: f("27AAPFU0939F1ZV"),
    buyer_name: f("Beta Stores"), buyer_gstin: missing(),
    invoice_number: f("INV-001"), invoice_date: f("2026-09-15"), place_of_supply: f("Maharashtra (27)"),
    taxable_value: f(1000), discount_total: missing(), cgst: f(90), sgst: f(90), igst: missing(), cess: missing(),
    grand_total: f(1180),
    line_items: [item()],
    ...over,
  };
}

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function minimalPdf(pages = 1, extra = "") {
  let body = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count " + pages + " >>\nendobj\n";
  for (let i = 0; i < pages; i++) body += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`;
  body += extra + "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return new TextEncoder().encode(body);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
}
export function png(width = 400, height = 400, { truncate = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return new Uint8Array(truncate ? bytes.subarray(0, bytes.length - 20) : bytes);
}
export function jpeg(width = 400, height = 400, { truncate = false, noSof = false } = {}) {
  const parts = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]; // SOI + tiny APP0
  if (!noSof) parts.push(0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00);
  parts.push(0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0x56);
  if (!truncate) parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}
