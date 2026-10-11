// Review checks. They only ADD flags. They never change an extracted value.
import { toPaise } from "./normalize.ts";
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

function nz(v: number | null): number {
  return v ?? 0;
}

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

  // 4. Tax type consistency: IGST and CGST/SGST do not normally appear together.
  if (nz(extracted.igst_amount) !== 0 && (nz(extracted.cgst_amount) !== 0 || nz(extracted.sgst_amount) !== 0)) {
    flags.push({ code: "tax_type_conflict", severity: "warning", message: "IGST and CGST/SGST are both present. Check which applies." });
  }

  // 5. Arithmetic. Tolerance covers normal rounding. Missing figures are never treated as zero silently.
  items.forEach((it, i) => {
    const q = it.quantity;
    const p = it.unit_price;
    const t = it.taxable_amount;
    if (q !== null && p !== null && t !== null) {
      const expected = toPaise(q * p) - toPaise(nz(it.discount_amount));
      const actual = toPaise(t);
      // Accept the line value with or without the item discount applied.
      const alt = toPaise(q * p);
      if (Math.abs(actual - expected) > tol && Math.abs(actual - alt) > tol) {
        flags.push({
          code: "arithmetic_line_mismatch",
          severity: "warning",
          field: "taxable_value",
          itemPosition: i + 1,
          message: "Quantity x unit price does not match the item's taxable value.",
          details: { expected: expected / 100, extracted: actual / 100 },
        });
      }
    }
  });

  const header = extracted.taxable_amount;
  if (header !== null && items.length > 0 && items.every((it) => it.taxable_amount !== null)) {
    const sum = items.reduce((a, it) => a + toPaise(it.taxable_amount as number), 0);
    const candidates = [toPaise(header)];
    if (extracted.discount_amount !== null) candidates.push(toPaise(header) + toPaise(extracted.discount_amount));
    if (!candidates.some((cnd) => Math.abs(sum - cnd) <= tol)) {
      flags.push({
        code: "arithmetic_subtotal_mismatch",
        severity: "error",
        field: "taxable_value",
        message: "The item taxable values do not add up to the invoice taxable value.",
        details: { itemsSum: sum / 100, extracted: header / 100 },
      });
    }
  }

  const total = extracted.total_amount;
  if (total !== null && header !== null) {
    const taxes = [extracted.cgst_amount, extracted.sgst_amount, extracted.igst_amount, extracted.cess_amount];
    const taxPaise = taxes.reduce<number>((a, v) => a + (v === null ? 0 : toPaise(v)), 0);
    const base = toPaise(header) + taxPaise;
    const candidates = [base];
    if (extracted.discount_amount !== null) candidates.push(base - toPaise(extracted.discount_amount));
    if (!candidates.some((cnd) => Math.abs(toPaise(total) - cnd) <= tol)) {
      const absent = (["cgst", "sgst", "igst", "cess"] as const).filter((k) => fs[k]?.state === "missing");
      flags.push({
        code: "arithmetic_total_mismatch",
        severity: "error",
        field: "grand_total",
        message: "Taxable value plus taxes does not equal the grand total.",
        details: { expected: base / 100, extracted: toPaise(total) / 100, taxFieldsNotFound: absent },
      });
    }
  }

  return flags;
}

export function outcomeFor(flags: ReviewFlag[]): "completed" | "needs_review" {
  return flags.some((f) => f.severity === "error" || f.severity === "warning") ? "needs_review" : "completed";
}
