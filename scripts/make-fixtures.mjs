// Generates SYNTHETIC invoice fixtures (fake parties, valid-format GSTINs) plus ground-truth JSON.
// Optional dev tool: needs `pdf-lib` and `sharp` (npm i -D pdf-lib sharp). The generated files are committed
// under tests/fixtures so this only needs to run when you add layouts.
//   node --experimental-strip-types scripts/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { gstinChecksumChar } from "../lib/extraction/normalize.ts";

const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
const sharp = (await import("sharp")).default;

const gstin = (state, pan, entity = "1") => {
  const base = `${state}${pan}${entity}Z`;
  return base + gstinChecksumChar(base);
};
const money = (n) => n.toFixed(2);
const out = new URL("../tests/fixtures/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const SUP1 = gstin("27", "ABCDE1234F");
const SUP2 = gstin("29", "PQRST5678K");
const BUY1 = gstin("27", "LMNOP4321Q");
const BUY2 = gstin("07", "UVWXY8765R");

// Each spec: how to draw it + the truth. null in truth = absent on the document.
const specs = [
  {
    id: "01-intra-state-grid", format: "pdf", layout: "grid", title: "TAX INVOICE",
    head: { supplier: ["Demo Hardware Pvt Ltd", "Plot 12, MIDC Andheri, Mumbai", `GSTIN: ${SUP1}`], buyer: ["Bright Builders", "14 Lake Road, Pune", `GSTIN: ${BUY1}`], no: "DH/26-27/0412", date: "15/09/2026", pos: "Maharashtra (27)" },
    items: [["Steel bolts M8", "7318", 100, "Nos", 12.5, 1250, 18], ["Hex nuts M8", "7318", 200, "Nos", 8, 1600, 18], ["Cable ties pack", "3926", 10, "Pkt", 45.5, 455, 18]],
    totals: [["Taxable value", 3305], ["CGST @9%", 297.45], ["SGST @9%", 297.45], ["Grand total", 3899.9]],
    truth: { supplier_name: "Demo Hardware Pvt Ltd", supplier_gstin: SUP1, buyer_name: "Bright Builders", buyer_gstin: BUY1, invoice_number: "DH/26-27/0412", invoice_date: "2026-09-15", place_of_supply: "Maharashtra (27)", taxable_value: 3305, discount_total: null, cgst: 297.45, sgst: 297.45, igst: null, cess: null, grand_total: 3899.9 },
  },
  {
    id: "02-inter-state-discount", format: "pdf", layout: "list", title: "Invoice",
    head: { supplier: ["Demo Office Supplies", "88 Brigade Road, Bengaluru", `GSTIN: ${SUP2}`], buyer: ["Nova Consulting LLP", "Connaught Place, New Delhi", `GSTIN: ${BUY2}`], no: "OS-2209", date: "02/10/2026", pos: "Delhi (07)" },
    items: [["Laptop stand", "9403", 3, "Nos", 1499, 4497, null], ["USB hub 7-port", "8517", 5, "Nos", 799, 3995, null]],
    totals: [["Sub total", 8492], ["Discount", 492], ["Taxable value", 8000], ["IGST @18%", 1440], ["Total payable", 9440]],
    truth: { supplier_name: "Demo Office Supplies", supplier_gstin: SUP2, buyer_name: "Nova Consulting LLP", buyer_gstin: BUY2, invoice_number: "OS-2209", invoice_date: "2026-10-02", place_of_supply: "Delhi (07)", taxable_value: 8000, discount_total: 492, cgst: null, sgst: null, igst: 1440, cess: null, grand_total: 9440 },
  },
  {
    id: "03-bill-of-supply", format: "pdf", layout: "list", title: "BILL OF SUPPLY",
    head: { supplier: ["Sunrise Tailoring", "Shop 4, Gandhi Market, Nagpur"], buyer: ["R. Mehta"], no: "117", date: "20/09/2026", pos: null },
    items: [["Stitching - shirt", null, 2, "Pcs", 350, 700, null], ["Alterations", null, 1, "Job", 150, 150, null]],
    totals: [["Total", 850]],
    truth: { supplier_name: "Sunrise Tailoring", supplier_gstin: null, buyer_name: "R. Mehta", buyer_gstin: null, invoice_number: "117", invoice_date: "2026-09-20", place_of_supply: null, taxable_value: null, discount_total: null, cgst: null, sgst: null, igst: null, cess: null, grand_total: 850 },
  },
  {
    id: "04-zero-rated-and-cess", format: "pdf", layout: "grid", title: "TAX INVOICE",
    head: { supplier: ["Demo Beverages LLP", "Hosur Road, Bengaluru", `GSTIN: ${SUP2}`], buyer: ["Cafe Aroma", "Indiranagar, Bengaluru"], no: "DB/0931", date: "05/10/2026", pos: "Karnataka (29)" },
    items: [["Packaged drinking water 1L", "2201", 50, "Nos", 20, 1000, 0], ["Aerated drink 600ml", "2202", 24, "Nos", 40, 960, 28]],
    totals: [["Taxable value", 1960], ["CGST", 134.4], ["SGST", 134.4], ["Cess", 96], ["Grand total", 2324.8]],
    truth: { supplier_name: "Demo Beverages LLP", supplier_gstin: SUP2, buyer_name: "Cafe Aroma", buyer_gstin: null, invoice_number: "DB/0931", invoice_date: "2026-10-05", place_of_supply: "Karnataka (29)", taxable_value: 1960, discount_total: null, cgst: 134.4, sgst: 134.4, igst: null, cess: 96, grand_total: 2324.8 },
  },
  {
    id: "05-scanned-png", format: "png", layout: "grid", title: "TAX INVOICE", scan: { rotate: 1.8, blur: 0.7 },
    head: { supplier: ["Demo Textiles", "Ring Road, Surat", `GSTIN: ${gstin("24", "FGHIJ2468L")}`], buyer: ["Kiran Garments", "Varachha, Surat"], no: "T/2026/88", date: "11/09/2026", pos: "Gujarat (24)" },
    items: [["Cotton fabric 40s", "5208", 120, "Mtr", 95, 11400, 5], ["Polyester lining", "5407", 60, "Mtr", 60, 3600, 5]],
    totals: [["Taxable value", 15000], ["CGST @2.5%", 375], ["SGST @2.5%", 375], ["Grand total", 15750]],
    truth: { supplier_name: "Demo Textiles", supplier_gstin: gstin("24", "FGHIJ2468L"), buyer_name: "Kiran Garments", buyer_gstin: null, invoice_number: "T/2026/88", invoice_date: "2026-09-11", place_of_supply: "Gujarat (24)", taxable_value: 15000, discount_total: null, cgst: 375, sgst: 375, igst: null, cess: null, grand_total: 15750 },
  },
  {
    id: "06-phone-photo-jpg", format: "jpg", layout: "list", title: "Tax Invoice", scan: { rotate: -2.5, blur: 1.1, dim: 0.78 },
    head: { supplier: ["Demo Pharma Distributors", "Station Road, Jaipur", `GSTIN: ${gstin("08", "KLMNO1357P")}`], buyer: ["Health Plus Chemist", "MI Road, Jaipur"], no: "PD-5521", date: "28/09/2026", pos: "Rajasthan (08)" },
    items: [["Paracetamol 500mg strip", "3004", 200, "Strip", 18.4, 3680, 12], ["ORS sachet", "3004", 100, "Pkt", 12, 1200, 12]],
    totals: [["Taxable value", 4880], ["CGST @6%", 292.8], ["SGST @6%", 292.8], ["Grand total", 5465.6]],
    truth: { supplier_name: "Demo Pharma Distributors", supplier_gstin: gstin("08", "KLMNO1357P"), buyer_name: "Health Plus Chemist", buyer_gstin: null, invoice_number: "PD-5521", invoice_date: "2026-09-28", place_of_supply: "Rajasthan (08)", taxable_value: 4880, discount_total: null, cgst: 292.8, sgst: 292.8, igst: null, cess: null, grand_total: 5465.6 },
  },
];

// ---- layout: produces text ops and lines in a 595x842 page --------------------------------------
function layout(spec) {
  const ops = [], lines = [];
  const t = (x, y, text, size = 10, bold = false) => ops.push({ x, y, text, size, bold });
  const grid = spec.layout === "grid";
  t(grid ? 220 : 40, 60, spec.title, 18, true);
  spec.head.supplier.forEach((s, i) => t(40, 100 + i * 14, s, i === 0 ? 12 : 9, i === 0));
  t(grid ? 380 : 40, grid ? 100 : 170, `Invoice No: ${spec.head.no}`, 10);
  t(grid ? 380 : 40, grid ? 116 : 184, `Date: ${spec.head.date}`, 10);
  if (spec.head.pos) t(grid ? 380 : 40, grid ? 132 : 198, `Place of Supply: ${spec.head.pos}`, 10);
  const by = grid ? 175 : 225;
  t(40, by, "Bill To:", 10, true);
  spec.head.buyer.forEach((s, i) => t(40, by + 14 + i * 13, s, 10));
  let y = by + 80;
  const cols = grid ? [40, 70, 250, 305, 350, 405, 470, 520] : [40, 70, 300, 360, 420, 500];
  const heads = grid ? ["#", "Description", "HSN", "Qty", "Unit", "Rate", "GST%", "Amount"] : ["#", "Item", "Qty", "Rate", "Amount"];
  lines.push([40, y - 14, 555, y - 14]);
  heads.forEach((h, i) => t(cols[i], y, h, 9, true));
  lines.push([40, y + 6, 555, y + 6]);
  spec.items.forEach(([name, hsn, qty, unit, rate, amt, gst], i) => {
    y += 22;
    if (grid) {
      [String(i + 1), name, hsn ?? "", String(qty), unit, money(rate), gst === null ? "" : `${gst}%`, money(amt)].forEach((v, c) => t(cols[c], y, v, 9));
    } else {
      [String(i + 1), `${name}${hsn ? ` (HSN ${hsn})` : ""}`, `${qty} ${unit}`, money(rate), money(amt)].forEach((v, c) => t(cols[c], y, v, 9));
    }
  });
  lines.push([40, y + 10, 555, y + 10]);
  y += 40;
  spec.totals.forEach(([label, v], i) => {
    const last = i === spec.totals.length - 1;
    t(340, y, label, last ? 11 : 10, last);
    t(480, y, money(v), last ? 11 : 10, last);
    y += 18;
  });
  t(40, 800, "Demo document generated for testing. Not a real invoice.", 7);
  return { ops, lines };
}

async function toPdf({ ops, lines }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const o of ops) page.drawText(o.text, { x: o.x, y: 842 - o.y, size: o.size, font: o.bold ? bold : font, color: rgb(0, 0, 0) });
  for (const [x1, y1, x2, y2] of lines) page.drawLine({ start: { x: x1, y: 842 - y1 }, end: { x: x2, y: 842 - y2 }, thickness: 0.7, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save());
}

async function toImage({ ops, lines }, spec) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842"><rect width="595" height="842" fill="#fbfbf8"/>` +
    lines.map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="#222" stroke-width="0.8"/>`).join("") +
    ops.map((o) => `<text x="${o.x}" y="${o.y}" font-family="Helvetica, Arial, sans-serif" font-size="${o.size}" font-weight="${o.bold ? 700 : 400}" fill="#111">${esc(o.text)}</text>`).join("") + `</svg>`;
  let img = sharp(Buffer.from(svg), { density: 216 }); // 3x: about 1785x2526 px
  const s = spec.scan ?? {};
  if (s.rotate) img = img.rotate(s.rotate, { background: "#e9e9e4" });
  if (s.blur) img = img.blur(s.blur);
  if (s.dim) img = img.modulate({ brightness: s.dim });
  return spec.format === "png" ? img.png({ compressionLevel: 9 }).toBuffer() : img.jpeg({ quality: 70 }).toBuffer();
}

for (const spec of specs) {
  const l = layout(spec);
  const file = `${spec.id}.${spec.format}`;
  writeFileSync(out + file, spec.format === "pdf" ? await toPdf(l) : await toImage(l, spec));
  const items = spec.items.map(([desc, hsn, qty, unit, rate, amt, gst]) => ({
    description: desc, hsn_sac: hsn, quantity: qty, unit, unit_price: rate, taxable_value: amt, gst_rate: spec.layout === "grid" ? gst : null,
  }));
  writeFileSync(out + `${spec.id}.truth.json`, JSON.stringify({ file, ...spec.truth, line_items: items }, null, 2) + "\n");
  console.log("wrote", file);
}
