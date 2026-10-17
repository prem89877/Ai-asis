// Zoho Books: turns one VERIFIED purchase invoice into a Zoho Books BILL and checks the result.
// !! Unit-tested with mocked HTTP only. Never run against a real Zoho Books organisation. !!
// Rules (each one is covered by tests/zoho-books.test.mjs):
//  * INR only. Invoices with cess, TCS, TDS, freight kept outside the taxable value, or negative lines are REFUSED with a reason
//    (use the Tally / CSV export for those). Nothing is guessed.
//  * One Zoho line per invoice line (quantity 1, rate = taxable value of the line, so the money is exact; the real quantity and unit
//    go into the description). The tax of each line is the Zoho tax whose percentage matches (IGST for inter-state, GST group otherwise).
//  * After the bill is created Zoho's total is compared with the invoice total. If it differs by more than the round-off window the bill
//    is DELETED again and the invoice is marked failed, so a wrong bill never stays in the books.
//  * Our invoice id is stored as the bill's reference number: a lost answer is recognised on the next try (no second bill).
import type { ExportInvoice, ExportItem } from "../export/columns.ts";
import { toPaise } from "../extraction/normalize.ts";
import { roundOffLimitPaise } from "../tally/build.ts";
import { PushRefusal } from "./push-sync.ts";
import type { Pusher } from "./push-sync.ts";
import type { ProviderOpts } from "./http.ts";
import { booksCreateBill, booksDeleteBill, booksFindBillByReference, booksFindOrCreateVendor, pickTax } from "./zoho.ts";
import type { BooksTax, ZohoRegion } from "./zoho.ts";

const ZOHO_STATE: Record<string, string> = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CH", "05": "UT", "06": "HR", "07": "DL", "08": "RJ", "09": "UP", "10": "BR", "11": "SK", "12": "AR", "13": "NL",
  "14": "MN", "15": "MZ", "16": "TR", "17": "ML", "18": "AS", "19": "WB", "20": "JH", "21": "OD", "22": "CG", "23": "MP", "24": "GJ", "25": "DD", "26": "DN",
  "27": "MH", "28": "AP", "29": "KA", "30": "GA", "31": "LD", "32": "KL", "33": "TN", "34": "PY", "35": "AN", "36": "TS", "37": "AP", "38": "LA",
};
const stateOf = (text: string | null | undefined): string | null => { const m = /^\s*(\d{2})/.exec(text ?? ""); return m ? (ZOHO_STATE[m[1]] ?? null) : null; };
const SLABS = [0, 0.25, 3, 5, 12, 18, 28];
const rupees = (paise: number) => Math.round(paise) / 100;

export interface BillContext { accountId: string; taxes: BooksTax[] }
export type BillBuild = { ok: true; bill: Record<string, unknown>; expectedPaise: number; adjustment: number } | { ok: false; reason: string };

export function buildBill(inv: ExportInvoice, items: ExportItem[], ctx: BillContext, vendorId: string): BillBuild {
  const no = (reason: string): BillBuild => ({ ok: false, reason });
  if (inv.status !== "verified") return no("Not verified.");
  if (!inv.invoice_number?.trim()) return no("Invoice number is missing.");
  if (!inv.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date)) return no("Invoice date is missing.");
  if (!inv.vendor_name?.trim()) return no("Supplier name is missing.");
  if (inv.total_amount === null || inv.taxable_amount === null) return no("Taxable value or invoice total is missing.");
  const cur = inv.currency?.trim().toUpperCase();
  if (cur && cur !== "INR") return no(`Currency ${inv.currency} is not supported; only INR.`);
  if (toPaise(inv.cess_amount ?? 0) !== 0) return no("This invoice has cess, which is not sent to Zoho Books yet. Use the Tally or CSV export.");
  if (toPaise(inv.tcs_amount ?? 0) !== 0 || toPaise(inv.tds_amount ?? 0) !== 0) return no("This invoice has TCS or TDS, which is not sent to Zoho Books yet. Use the Tally or CSV export.");
  if (toPaise(inv.pre_tax_charges ?? 0) !== 0) return no("This invoice has freight or packing outside the taxable value, which is not sent to Zoho Books yet.");

  const taxable = toPaise(inv.taxable_amount);
  const cgst = toPaise(inv.cgst_amount ?? 0), sgst = toPaise(inv.sgst_amount ?? 0), utgst = toPaise(inv.utgst_amount ?? 0), igst = toPaise(inv.igst_amount ?? 0);
  const taxes = cgst + sgst + utgst + igst;
  const inter = igst > 0;
  const total = toPaise(inv.total_amount);
  if (taxable < 0 || total <= 0) return no("Negative amounts (credit notes) are not supported.");

  type Line = { description: string; taxable: number; rate: number; hsn: string | null };
  let lines: Line[];
  const usable = items.filter((i) => i.taxable_amount !== null);
  if (usable.length > 0) {
    if (usable.some((i) => (i.taxable_amount ?? 0) < 0)) return no("Negative line amounts (credit notes) are not supported.");
    lines = usable.map((i) => ({
      description: [i.description?.trim() || `Item ${i.position}`, i.quantity !== null ? `(${i.quantity}${i.unit ? " " + i.unit : ""}${i.unit_price !== null ? " x " + i.unit_price : ""})` : ""].filter(Boolean).join(" ").slice(0, 2000),
      taxable: toPaise(i.taxable_amount ?? 0), rate: i.gst_rate ?? NaN, hsn: i.hsn_code?.trim() || null,
    }));
    if (lines.some((l) => !Number.isFinite(l.rate))) return no("A line has no GST rate. Correct it in Review and verify again.");
    const sum = lines.reduce((s, l) => s + l.taxable, 0);
    if (Math.abs(sum - taxable) > 100) return no("The line items do not add up to the taxable value. Correct them in Review and verify again.");
  } else {
    // No lines: a single rate is derived from the printed taxes and accepted only when it reproduces them.
    const pct = taxable > 0 ? (taxes / taxable) * 100 : 0;
    const slab = SLABS.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));
    if (Math.abs(Math.round((taxable * slab) / 100) - taxes) > 100) return no("The invoice has no line items and its tax is not a single standard GST rate. Add the lines in Review.");
    lines = [{ description: `Purchase ${inv.invoice_number.trim()}`, taxable, rate: slab, hsn: null }];
  }

  // Taxes Zoho will compute
  let computed = 0;
  const lineItems: Record<string, unknown>[] = [];
  for (const l of lines) {
    let taxId: string | undefined;
    if (l.rate > 0) {
      const t = pickTax(ctx.taxes, l.rate, inter);
      if (!t) return no(`Zoho Books has no ${inter ? "IGST" : "GST"} ${l.rate}% tax. Create it in Zoho Books (Settings > Taxes) and sync again.`);
      taxId = t.id;
      computed += Math.round((l.taxable * l.rate) / 100);
    }
    lineItems.push({ account_id: ctx.accountId, description: l.description, quantity: 1, rate: rupees(l.taxable), ...(l.hsn ? { hsn_or_sac: l.hsn } : {}), ...(taxId ? { tax_id: taxId } : {}) });
  }
  const sumTaxable = lines.reduce((s, l) => s + l.taxable, 0);
  const printed = sumTaxable + taxes;
  if (Math.abs(computed - taxes) > 100) return no("The GST printed on the invoice does not match the GST of the lines. Correct it in Review and verify again.");
  const adjPaise = total - (sumTaxable + computed);
  if (Math.abs(adjPaise) > roundOffLimitPaise(total)) return no(`Taxable value plus taxes is ${rupees(printed)} but the invoice total is ${rupees(total)}. Correct the figures in Review, verify again, then sync.`);

  const gstin = inv.vendor_gstin?.replace(/\s+/g, "").toUpperCase() || null;
  const source = stateOf(gstin), dest = stateOf(inv.place_of_supply);
  const bill: Record<string, unknown> = {
    vendor_id: vendorId, bill_number: inv.invoice_number.trim().slice(0, 100), date: inv.invoice_date, reference_number: inv.id,
    notes: `AI Asis ${inv.id}`, is_inclusive_tax: false, gst_treatment: gstin ? "business_gst" : "business_none",
    ...(source ? { source_of_supply: source } : {}), ...(dest ? { destination_of_supply: dest } : {}),
    line_items: lineItems,
    ...(adjPaise !== 0 ? { adjustment: rupees(adjPaise), adjustment_description: "Round off" } : {}),
  };
  return { ok: true, bill, expectedPaise: total, adjustment: rupees(adjPaise) };
}

export interface BooksPusherArgs { token: string; region: ZohoRegion; orgId: string; accountId: string; taxes: BooksTax[]; items: Map<string, ExportItem[]>; opts?: ProviderOpts }

export function booksPusher(a: BooksPusherArgs): Pusher {
  const o = a.opts ?? {};
  return {
    async push(inv) {
      // 1. A bill carrying this invoice id already exists (the answer of an earlier attempt was lost): done, nothing is created.
      const existing = await booksFindBillByReference(a.token, a.region, a.orgId, inv.id, o);
      if (existing) return { recovered: true };
      // 2. Check the invoice BEFORE touching the books (no vendor is created for an invoice that will be refused).
      const probe = buildBill(inv, a.items.get(inv.id) ?? [], { accountId: a.accountId, taxes: a.taxes }, "pending");
      if (!probe.ok) throw new PushRefusal(probe.reason);
      const vendorId = await booksFindOrCreateVendor(a.token, a.region, a.orgId, { name: inv.vendor_name!.trim(), gstin: inv.vendor_gstin?.replace(/\s+/g, "").toUpperCase() || null }, o);
      const built = buildBill(inv, a.items.get(inv.id) ?? [], { accountId: a.accountId, taxes: a.taxes }, vendorId);
      if (!built.ok) throw new PushRefusal(built.reason);
      // 3. Create, then verify Zoho's total. A wrong bill is removed again.
      const created = await booksCreateBill(a.token, a.region, a.orgId, built.bill, o);
      if (!Number.isFinite(created.total) || Math.abs(toPaise(created.total) - built.expectedPaise) > 100) {
        const removed = await booksDeleteBill(a.token, a.region, a.orgId, created.id, o);
        throw new PushRefusal(removed
          ? "Zoho Books calculated a different total than the invoice, so the bill was removed again. Check the GST taxes in Zoho Books and the invoice figures."
          : "Zoho Books calculated a different total than the invoice and the bill could not be removed. Delete bill " + inv.invoice_number + " in Zoho Books by hand.", "total_mismatch");
      }
      return {};
    },
  };
}
