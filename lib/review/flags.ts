// Recomputes every review flag from the CURRENT values of an invoice (used after a human edit).
// Extraction-time flags are deliberately not carried over: they described the old values.
// Flags only point at problems. Values are never changed here.
import { runChecks } from "../extraction/checks.ts";
import { GSTIN_AUTO_CORRECTED_LABEL, suggestGstinFixes, suggestionText } from "../extraction/gstin.ts";
import { checkGstin, gstinChecksumFlagText, GSTIN_PRINT_ERROR_CONFIDENCE } from "../extraction/normalize.ts";
import type { FieldMeta, ModelOutput, ReviewFlag, StoredExtracted, StoredItem } from "../extraction/types.ts";
import { HEADER_FIELDS } from "./fields.ts";
import type { HeaderValues } from "./fields.ts";
import { gstChecks } from "./gst.ts";

export interface FlagOptions {
  lowConfidence: number;
  tolerancePaise: number;
}

const GST_START = "2017-07-01";

function num(v: string | number | null): number | null {
  return v === null || v === "" ? null : Number(v);
}

// `extras` = values the review screen does not edit but the validation engine needs (TCS, TDS, pre-tax charges,
// round-off, exchange rate). They come from the saved record, so a re-check after an edit never forgets them.
export type ReviewExtras = Pick<StoredExtracted, "exchange_rate" | "tcs_amount" | "tds_amount" | "pre_tax_charges" | "round_off_amount" | "irn" | "ack_no" | "eway_bill_no">;

export function toStoredExtracted(h: HeaderValues, fieldStatus: Record<string, FieldMeta>, extras: Partial<ReviewExtras> = {}): StoredExtracted {
  return {
    ...extras,
    vendor_name: h.vendor_name as string | null,
    buyer_name: h.buyer_name as string | null,
    vendor_gstin: h.vendor_gstin as string | null,
    buyer_gstin: h.buyer_gstin as string | null,
    invoice_number: h.invoice_number as string | null,
    invoice_number_norm: null,
    invoice_date: h.invoice_date as string | null,
    place_of_supply: h.place_of_supply as string | null,
    currency: h.currency as string | null,
    taxable_amount: num(h.taxable_amount),
    discount_amount: num(h.discount_amount),
    cgst_amount: num(h.cgst_amount),
    sgst_amount: num(h.sgst_amount),
    igst_amount: num(h.igst_amount),
    cess_amount: num(h.cess_amount),
    total_amount: num(h.total_amount),
    confidence: null,
    document_type: (h.document_type as StoredExtracted["document_type"]) ?? "tax_invoice",
    field_status: fieldStatus,
    review_flags: [],
    raw_extraction: {} as ModelOutput,
    extraction_model: "",
  };
}

export function computeReviewFlags(h: HeaderValues, fieldStatus: Record<string, FieldMeta>, items: StoredItem[], opts: FlagOptions, now: Date = new Date(), extras: Partial<ReviewExtras> = {}): ReviewFlag[] {
  const doc = toStoredExtracted(h, fieldStatus, extras);
  const flags: ReviewFlag[] = [];
  const memo = doc.document_type === "credit_note" || doc.document_type === "debit_note";

  // Format checks that the extraction step does once, repeated here for the edited values.
  for (const [col, key] of [["vendor_gstin", "supplier_gstin"], ["buyer_gstin", "buyer_gstin"]] as const) {
    const g = doc[col];
    if (g) {
      const c = checkGstin(g);
      const ac = fieldStatus[key]?.autoCorrected;
      if (c.ok && ac && g === ac.to) {
        // Still the automatically validated GSTIN: keep the audit note (info only, never a warning).
        flags.push({ code: "gstin_auto_corrected", severity: "info", field: key, message: GSTIN_AUTO_CORRECTED_LABEL, details: { gstin_auto_corrected: true, original_raw_gstin: ac.from, corrected_gstin: ac.to } });
      } else if (!c.ok) {
        // A value a reviewer typed/corrected, or one that two AI readings agreed on with high confidence, is not called "misread".
        const meta = fieldStatus[key];
        const suggestions = suggestGstinFixes(g);
        const extra = { reason: c.reason, ...(suggestions.length ? { suggestions } : {}) };
        const hint = suggestionText(suggestions);
        if (c.reason === "format") {
          flags.push({ code: "invalid_gstin", severity: "warning", field: key, message: "This is not a valid GSTIN format. Check the original." + hint, details: extra });
        } else if (meta?.source === "human") {
          flags.push({ code: "gstin_checksum_note", severity: "info", field: key, message: "GSTIN Checksum Mismatch (Possible Print Error). It was entered or corrected by a reviewer, so it is kept as is." + hint, details: { ...extra, confirmedBy: "human" } });
        } else {
          const printError = meta?.source === "recheck" && meta.confidence > GSTIN_PRINT_ERROR_CONFIDENCE;
          const t = gstinChecksumFlagText(printError);
          flags.push({ code: printError ? "gstin_checksum_note" : "invalid_gstin", severity: t.severity, field: key, message: t.message + hint, details: { ...extra, ...(printError ? { confirmedByRecheck: true } : {}) } });
        }
      }
    }
  }
  if (doc.invoice_date) {
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (doc.invoice_date < GST_START || doc.invoice_date > tomorrow) {
      flags.push({ code: "implausible_date", severity: "warning", field: "invoice_date", message: "The invoice date is before GST started or in the future. Check the original." });
    }
  }
  for (const def of HEADER_FIELDS) {
    const st = fieldStatus[def.statusKey]?.state;
    if (st === "invalid" && h[def.column] === null) {
      flags.push({
        code: "value_not_saved", severity: def.kind === "date" ? "error" : "warning", field: def.statusKey,
        message: `The ${def.label.toLowerCase()} could not be saved from the original document. Enter it from the original.`,
      });
    }
    if (def.kind === "amount" && !memo) {
      const v = num(h[def.column]);
      if (v !== null && v < 0) {
        flags.push({ code: "negative_amount", severity: "warning", field: def.statusKey, message: `The ${def.label.toLowerCase()} is negative. Check the original.` });
      }
    }
  }

  flags.push(...runChecks(doc, items, opts));
  flags.push(...gstChecks(doc, items, { tolerancePaise: opts.tolerancePaise }));
  return flags;
}

export function hasOpenFlags(flags: ReviewFlag[]): boolean {
  return flags.some((f) => f.severity === "error" || f.severity === "warning");
}
