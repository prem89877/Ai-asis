// Builds arithmetically consistent invoices (model output shape) for tests and the offline evaluation.
import { computeGstinCheckDigit } from "../../lib/extraction/gstin.ts";
import { f, missing } from "../helpers.mjs";

const r2 = (n) => Math.round(n * 100) / 100;
const withCheck = (first14) => first14 + computeGstinCheckDigit(first14);
export const SUPPLIER_GSTIN = "27AAPFU0939F1ZV"; // Maharashtra, check digit valid
export const BUYER_GSTIN_MH = withCheck("27ABCDE1234F1Z");
export const BUYER_GSTIN_KA = withCheck("29ABCDE1234F1Z");

// rows: [{ d: description, q: quantity, p: unit price, r: gst rate, hsn }]
export function invoice(rows, { inter = false, number = "INV-001", date = "2026-09-15", buyerGstin = null, cess = 0, over = {} } = {}) {
  const lines = rows.map((x) => {
    const taxable = r2(x.q * x.p);
    const tax = r2((taxable * x.r) / 100);
    return { x, taxable, tax };
  });
  const taxable = r2(lines.reduce((a, l) => a + l.taxable, 0));
  const tax = r2(lines.reduce((a, l) => a + l.tax, 0));
  const half = r2(tax / 2);
  const grand = r2(taxable + tax + cess);
  const itemsOut = lines.map(({ x, taxable: tv, tax: ta }) => ({
    description: f(x.d), hsn_sac: f(x.hsn ?? "8471"), unit: f("Nos"), quantity: f(x.q), unit_price: f(x.p), discount: missing(),
    taxable_value: f(tv), gst_rate: f(x.r), tax_amount: f(ta), line_total: f(r2(tv + ta)),
  }));
  return {
    document_type: "tax_invoice", currency: f("INR"),
    supplier_name: f("Acme Traders"), supplier_gstin: f(SUPPLIER_GSTIN),
    buyer_name: f("Beta Stores"), buyer_gstin: buyerGstin ? f(buyerGstin) : missing(),
    invoice_number: f(number), invoice_date: f(date), place_of_supply: f(inter ? "Karnataka (29)" : "Maharashtra (27)"),
    taxable_value: f(taxable), discount_total: missing(),
    cgst: inter ? missing() : f(half), sgst: inter ? missing() : f(half), igst: inter ? f(tax) : missing(), cess: cess ? f(cess) : missing(),
    grand_total: f(grand), line_items: itemsOut, ...over,
  };
}

// Deep copy with edits: set(m, "grand_total", 1810) or set(m, "line_items.0.unit_price", 5000). conf = confidence of the edited field.
export function set(m, path, value, conf) {
  const c = JSON.parse(JSON.stringify(m));
  const keys = path.split(".");
  let o = c;
  for (const k of keys.slice(0, -1)) o = o[k];
  const last = keys[keys.length - 1];
  const prev = o[last];
  o[last] = value && typeof value === "object" && "status" in value ? value : { status: "present", value, confidence: conf ?? prev?.confidence ?? 0.95 };
  return c;
}
