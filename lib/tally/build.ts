// Tally-compatible purchase-voucher export (XML, JSON, CSV) built from VERIFIED invoices.
//
// !! STATUS: EXPERIMENTAL / NOT VERIFIED. !!
// The XML follows the structure of Tally's documented "Import Data" request for vouchers (ENVELOPE > BODY > IMPORTDATA >
// REQUESTDATA > TALLYMESSAGE > VOUCHER with ledger entries), written from the published format. It has NOT been imported
// into Tally Prime / Tally.ERP 9 in this project. The unit tests check that the output is well-formed XML and that every
// voucher balances to zero; they do not prove that Tally accepts it. Test with a copy of a company in YOUR Tally version
// before trusting it, and see docs/PHASE6_PART1_SETUP.md. The route that serves it is ON by default; it is switched off only with TALLY_EXPORT_ENABLED=false.
//
// What it does NOT do: it never connects to Tally, never posts anything, never creates ledgers or stock items, and does
// not carry GST registration details or bill-wise allocations. Party and tax ledgers must already exist in Tally under
// exactly the names configured here, otherwise Tally rejects the voucher.
import type { ExportInvoice } from "../export/columns.ts";
import { dedupeKey } from "../integrations/mapping.ts";

export interface TallyConfig {
  voucherType: string;
  purchaseLedger: string;
  cgstLedger: string;
  sgstLedger: string;
  utgstLedger: string;
  igstLedger: string;
  cessLedger: string;
  roundOffLedger: string;
  companyName: string; // optional; empty = Tally uses the company that is currently open
}

export const DEFAULT_TALLY_CONFIG: TallyConfig = {
  voucherType: "Purchase",
  purchaseLedger: "Purchase",
  cgstLedger: "Input CGST",
  sgstLedger: "Input SGST",
  utgstLedger: "Input UTGST",
  igstLedger: "Input IGST",
  cessLedger: "Input Cess",
  roundOffLedger: "Round Off",
  companyName: "",
};

export type TallyConfigCheck = { ok: true; config: TallyConfig } | { ok: false; message: string };

const NAME_RE = /^[^\u0000-\u001F<>&"]{1,100}$/; // letters, digits, spaces, punctuation; no control characters or XML specials

export function validateTallyConfig(raw: unknown): TallyConfigCheck {
  if (raw === undefined || raw === null) return { ok: true, config: { ...DEFAULT_TALLY_CONFIG } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Invalid ledger settings." };
  const r = raw as Record<string, unknown>;
  const out: TallyConfig = { ...DEFAULT_TALLY_CONFIG };
  for (const k of Object.keys(DEFAULT_TALLY_CONFIG) as (keyof TallyConfig)[]) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "string") return { ok: false, message: `Invalid value for ${k}.` };
    const v = (r[k] as string).trim();
    if (k === "companyName" && v === "") { out[k] = ""; continue; }
    if (!NAME_RE.test(v)) return { ok: false, message: `Invalid name for ${k}: use 1-100 characters, without < > & or quotes.` };
    out[k] = v;
  }
  return { ok: true, config: out };
}

export interface TallyEntry { ledger: string; side: "Dr" | "Cr"; paise: number; isParty: boolean }
export interface TallyVoucher {
  invoiceId: string;
  date: string; // YYYYMMDD
  voucherType: string;
  voucherNumber: string;
  reference: string;
  partyLedger: string;
  narration: string;
  supplierGstin: string | null;
  entries: TallyEntry[];
}
export interface TallySkip { invoiceId: string; invoiceNumber: string | null; reason: string }

const toPaise = (n: number | null): number => (n === null || n === undefined ? 0 : Math.round(Number(n) * 100));
const ROUND_OFF_LIMIT_PAISE = 100; // up to INR 1.00 is treated as round-off; more means the invoice does not add up

export function buildVouchers(invoices: ExportInvoice[], config: TallyConfig): { vouchers: TallyVoucher[]; skipped: TallySkip[] } {
  const vouchers: TallyVoucher[] = [];
  const skipped: TallySkip[] = [];
  const seen = new Set<string>();
  const sorted = [...invoices].sort((a, b) => (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "") || (a.invoice_number ?? "").localeCompare(b.invoice_number ?? "", "en", { numeric: true }));

  for (const inv of sorted) {
    const skip = (reason: string) => skipped.push({ invoiceId: inv.id, invoiceNumber: inv.invoice_number, reason });
    if (inv.status !== "verified") { skip("Not verified."); continue; }
    if (!inv.invoice_number) { skip("Invoice number is missing."); continue; }
    if (!inv.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date)) { skip("Invoice date is missing."); continue; }
    if (!inv.vendor_name?.trim()) { skip("Supplier name is missing."); continue; }
    if (inv.total_amount === null || inv.taxable_amount === null) { skip("Taxable value or invoice total is missing."); continue; }
    if (inv.currency && inv.currency !== "INR") { skip(`Currency ${inv.currency} is not supported; only INR.`); continue; }
    const key = dedupeKey(inv);
    if (key && seen.has(key)) { skip("Duplicate of another invoice in this export."); continue; }
    if (key) seen.add(key);

    const total = toPaise(inv.total_amount);
    const parts: { ledger: string; paise: number }[] = [
      { ledger: config.purchaseLedger, paise: toPaise(inv.taxable_amount) },
      { ledger: config.cgstLedger, paise: toPaise(inv.cgst_amount) },
      { ledger: config.sgstLedger, paise: toPaise(inv.sgst_amount) },
      { ledger: config.utgstLedger, paise: toPaise(inv.utgst_amount ?? 0) }, // own ledger: UTGST is never booked to the SGST ledger
      { ledger: config.igstLedger, paise: toPaise(inv.igst_amount) },
      { ledger: config.cessLedger, paise: toPaise(inv.cess_amount) },
    ].filter((p) => p.paise !== 0);
    if (total <= 0) { skip("Invoice total must be above zero."); continue; }
    if (parts.some((p) => p.paise < 0)) { skip("Negative amounts (credit notes) are not supported."); continue; }

    const sum = parts.reduce((s, p) => s + p.paise, 0);
    const diff = total - sum; // > 0: total is more than the parts, so a round-off DEBIT is needed
    if (Math.abs(diff) > ROUND_OFF_LIMIT_PAISE) { skip(`Taxable value plus taxes is ${money(sum)} but the invoice total is ${money(total)} (difference ${money(Math.abs(diff))}). Correct the figures in Review, verify again, then export.`); continue; }

    const entries: TallyEntry[] = [{ ledger: inv.vendor_name.trim(), side: "Cr", paise: total, isParty: true }];
    for (const p of parts) entries.push({ ledger: p.ledger, side: "Dr", paise: p.paise, isParty: false });
    if (diff > 0) entries.push({ ledger: config.roundOffLedger, side: "Dr", paise: diff, isParty: false });
    if (diff < 0) entries.push({ ledger: config.roundOffLedger, side: "Cr", paise: -diff, isParty: false });

    vouchers.push({
      invoiceId: inv.id,
      date: inv.invoice_date.replace(/-/g, ""),
      voucherType: config.voucherType,
      voucherNumber: inv.invoice_number.trim(),
      reference: inv.invoice_number.trim(),
      partyLedger: inv.vendor_name.trim(),
      narration: `AI Asis ${inv.id}${inv.vendor_gstin ? ` | GSTIN ${inv.vendor_gstin}` : ""}`,
      supplierGstin: inv.vendor_gstin,
      entries,
    });
  }
  return { vouchers, skipped };
}

export function voucherBalance(v: TallyVoucher): number {
  return v.entries.reduce((s, e) => s + (e.side === "Cr" ? e.paise : -e.paise), 0); // must be 0
}

// XML 1.0 forbids most control characters; strip them, then escape the five specials.
export function xmlEscape(s: string): string {
  return s
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const money = (paise: number): string => `${paise < 0 ? "-" : ""}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, "0")}`;

export function toTallyXml(vouchers: TallyVoucher[], config: TallyConfig): string {
  const x = xmlEscape;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push("<ENVELOPE>");
  lines.push("  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>");
  lines.push("  <BODY><IMPORTDATA>");
  lines.push("    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>");
  if (config.companyName) lines.push(`      <STATICVARIABLES><SVCURRENTCOMPANY>${x(config.companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>`);
  lines.push("    </REQUESTDESC>");
  lines.push("    <REQUESTDATA>");
  for (const v of vouchers) {
    lines.push('      <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    lines.push(`        <VOUCHER VCHTYPE="${x(v.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`);
    lines.push(`          <DATE>${v.date}</DATE>`);
    lines.push(`          <VOUCHERTYPENAME>${x(v.voucherType)}</VOUCHERTYPENAME>`);
    lines.push(`          <VOUCHERNUMBER>${x(v.voucherNumber)}</VOUCHERNUMBER>`);
    lines.push(`          <REFERENCE>${x(v.reference)}</REFERENCE>`);
    lines.push(`          <PARTYLEDGERNAME>${x(v.partyLedger)}</PARTYLEDGERNAME>`);
    lines.push(`          <NARRATION>${x(v.narration)}</NARRATION>`);
    for (const e of v.entries) {
      const signed = e.side === "Cr" ? e.paise : -e.paise; // credit positive, debit negative
      lines.push("          <ALLLEDGERENTRIES.LIST>");
      lines.push(`            <LEDGERNAME>${x(e.ledger)}</LEDGERNAME>`);
      lines.push(`            <ISDEEMEDPOSITIVE>${e.side === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`);
      if (e.isParty) lines.push("            <ISPARTYLEDGER>Yes</ISPARTYLEDGER>");
      lines.push(`            <AMOUNT>${money(signed)}</AMOUNT>`);
      lines.push("          </ALLLEDGERENTRIES.LIST>");
    }
    lines.push("        </VOUCHER>");
    lines.push("      </TALLYMESSAGE>");
  }
  lines.push("    </REQUESTDATA>");
  lines.push("  </IMPORTDATA></BODY>");
  lines.push("</ENVELOPE>");
  return lines.join("\r\n") + "\r\n";
}

export function toTallyJson(vouchers: TallyVoucher[], skipped: TallySkip[], config: TallyConfig): string {
  return JSON.stringify({
    format: "ai-asis-tally-vouchers",
    version: 1,
    status: "experimental-unverified",
    voucherType: config.voucherType,
    vouchers: vouchers.map((v) => ({
      aiAsisId: v.invoiceId, date: v.date, voucherType: v.voucherType, voucherNumber: v.voucherNumber, reference: v.reference,
      partyLedger: v.partyLedger, supplierGstin: v.supplierGstin, narration: v.narration,
      entries: v.entries.map((e) => ({ ledger: e.ledger, side: e.side, amount: money(e.paise), isPartyLedger: e.isParty })),
    })),
    skipped,
  }, null, 2) + "\n";
}

function csvField(s: string): string {
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]|^\s|\s$/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

// One row per ledger entry (voucher lines), the layout most Excel-to-Tally import utilities expect. Not verified with any of them.
export function toTallyCsv(vouchers: TallyVoucher[]): string {
  const head = ["Date", "Voucher Type", "Voucher No", "Reference", "Party Ledger", "Ledger Name", "Dr/Cr", "Amount", "Narration", "Supplier GSTIN", "AI Asis ID"];
  const rows: string[] = [head.join(",")];
  for (const v of vouchers) {
    for (const e of v.entries) {
      rows.push([v.date, v.voucherType, v.voucherNumber, v.reference, v.partyLedger, e.ledger, e.side, money(e.paise), v.narration, v.supplierGstin ?? "", v.invoiceId].map(csvField).join(","));
    }
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
