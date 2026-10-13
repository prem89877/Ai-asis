// Review checks. They only ADD flags. They never change an extracted value.
import { validateInvoice } from "./gst-engine.ts";
import type { FieldMeta, ReviewFlag, StoredExtracted, StoredItem } from "./types.ts";

export interface CheckOptions {
  lowConfidence: number;
  tolerancePaise: number;
}

// Fields that must be readable for the invoice to be usable. Missing/unreadable => error.
const REQUIRED: Record<string, string> = {
  supplier_name: "supplier name",
  invoice_number: "invoice number",
  invoice_date: "invoice date",
  grand_total: "grand total",
};
// Normal on most tax invoices, so absence deserves a look.
const EXPECTED: Record<string, string> = {
  supplier_gstin: "supplier GSTIN",
  buyer_name: "buyer name",
  taxable_value: "taxable value",
};
// Often absent on small or B2C invoices. Informational.
const OPTIONAL_NOTE: Record<string, string> = {
  buyer_gstin: "buyer GSTIN",
  place_of_supply: "place of supply",
};

export function runChecks(extracted: StoredExtracted, items: StoredItem[], opts: CheckOptions): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const tol = opts.tolerancePaise;
  const fs = extracted.field_status;

  if (extracted.document_type === "not_an_invoice") {
    flags.push({ code: "not_an_invoice", severity: "error", message: "This file does not look like an invoice." });
  }

  // 1. Missing / unreadable / invalid header fields (invalid ones already carry their own flag).
  const describe = (state: FieldMeta["state"]) => (state === "missing" ? "was not found on the document" : "could not be read reliably");
  for (const [key, label] of Object.entries(REQUIRED)) {
    const st = fs[key]?.state;
    if (st === "missing" || st === "unreadable") {
      flags.push({ code: st === "missing" ? "missing_required" : "unreadable_field", severity: "error", field: key, message: `The ${label} ${describe(st)}.` });
    }
  }
  for (const [key, label] of Object.entries(EXPECTED)) {
    const st = fs[key]?.state;
    if (st === "missing" || st === "unreadable") {
      flags.push({ code: st === "missing" ? "missing_field" : "unreadable_field", severity: "warning", field: key, message: `The ${label} ${describe(st)}.` });
    }
  }
  for (const [key, label] of Object.entries(OPTIONAL_NOTE)) {
    const st = fs[key]?.state;
    if (st === "missing") flags.push({ code: "missing_field", severity: "info", field: key, message: `The ${label} was not found on the document.` });
    if (st === "unreadable") flags.push({ code: "unreadable_field", severity: "warning", field: key, message: `The ${label} could not be read reliably.` });
  }
  // Tax/discount amounts: unreadable matters, absent is normal.
  for (const key of ["discount_total", "cgst", "sgst", "igst", "cess", "currency"]) {
    if (fs[key]?.state === "unreadable") flags.push({ code: "unreadable_field", severity: "warning", field: key, message: `The ${key.replace("_", " ")} could not be read reliably.` });
  }

  // 2. Low confidence on header fields.
  for (const [key, m] of Object.entries(fs)) {
    if ((m.state === "value" || m.state === "zero") && m.confidence < opts.lowConfidence) {
      flags.push({ code: "low_confidence", severity: "warning", field: key, message: `The ${key.replace(/_/g, " ")} was read with low confidence. Check the original.`, details: { confidence: m.confidence } });
    }
  }

  // 3. Item-level readability and confidence, one flag per item field group to keep the list short.
  const unreadable: { position: number; field: string }[] = [];
  const lowConf: { position: number; field: string }[] = [];
  items.forEach((it, i) => {
    for (const [key, m] of Object.entries(it.field_status)) {
      if (m.state === "unreadable") unreadable.push({ position: i + 1, field: key });
      else if ((m.state === "value" || m.state === "zero") && m.confidence < opts.lowConfidence) lowConf.push({ position: i + 1, field: key });
    }
  });
  if (unreadable.length) {
    flags.push({ code: "unreadable_item_field", severity: "warning", message: `${unreadable.length} item value(s) could not be read reliably.`, details: { fields: unreadable.slice(0, 50) } });
  }
  if (lowConf.length) {
    flags.push({ code: "low_confidence_item", severity: "warning", message: `${lowConf.length} item value(s) were read with low confidence.`, details: { fields: lowConf.slice(0, 50) } });
  }

  // 4. + 5. Line arithmetic (INR and foreign currency), tax allocation (mixed IGST + CGST/SGST is allowed when the lines
  // add up), grand total with TCS / TDS / pre-tax charges / round-off, and the GST cross check. See gst-engine.ts.
  flags.push(...validateInvoice({ extracted, items }, { tolerancePaise: tol }).flags);

  return flags;
}

export function outcomeFor(flags: ReviewFlag[]): "completed" | "needs_review" {
  return flags.some((f) => f.severity === "error" || f.severity === "warning") ? "needs_review" : "completed";
}
