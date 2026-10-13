// Supabase implementation of the extraction store and file source.
// Uses the service-role client, so every query here is explicitly scoped by firm_id
// and the caller must already have authorized the user.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompleteArgs, CompleteResult, DuplicateCandidate, DuplicateQuery, ExtractionStore, FileSource, UsageRecordInput } from "./pipeline.ts";

export function createSupabaseStore(admin: SupabaseClient): ExtractionStore {
  return {
    async recordUsage(r: UsageRecordInput) {
      const { error } = await admin.from("usage_records").insert({
        firm_id: r.firmId,
        user_id: r.userId,
        kind: "extraction",
        quantity: 1,
        invoice_id: r.invoiceId,
        job_id: r.jobId,
        model: r.model,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        estimated_cost_usd: r.costUsd,
        outcome: r.outcome,
      });
      if (error) throw new Error("usage_insert_failed");
    },

    async findDuplicateCandidates(q: DuplicateQuery): Promise<DuplicateCandidate[]> {
      const found = new Map<string, DuplicateCandidate>();
      const add = (rows: unknown, matchedBy: DuplicateCandidate["matchedBy"]) => {
        for (const row of (rows ?? []) as { invoice_id: string; vendor_gstin: string | null; vendor_name: string | null }[]) {
          if (!found.has(row.invoice_id) || matchedBy === "fingerprint") {
            found.set(row.invoice_id, { invoiceId: row.invoice_id, vendorGstin: row.vendor_gstin, vendorName: row.vendor_name, matchedBy });
          }
        }
      };

      if (q.invoiceNumberNorm) {
        const { data, error } = await admin
          .from("extracted_data")
          .select("invoice_id, vendor_gstin, vendor_name")
          .eq("firm_id", q.firmId)
          .eq("invoice_number_norm", q.invoiceNumberNorm)
          .neq("invoice_id", q.invoiceId)
          .limit(20);
        if (error) throw new Error("duplicate_query_failed");
        add(data, "number");
      }
      if (q.vendorGstin && q.invoiceDate && q.totalAmount !== null) {
        const { data, error } = await admin
          .from("extracted_data")
          .select("invoice_id, vendor_gstin, vendor_name")
          .eq("firm_id", q.firmId)
          .eq("vendor_gstin", q.vendorGstin)
          .eq("invoice_date", q.invoiceDate)
          .eq("total_amount", q.totalAmount)
          .neq("invoice_id", q.invoiceId)
          .limit(20);
        if (error) throw new Error("duplicate_query_failed");
        add(data, "fingerprint");
      }
      return Array.from(found.values());
    },

    async complete(a: CompleteArgs): Promise<CompleteResult> {
      const e = a.extracted;
      const extracted = e
        ? {
            vendor_name: e.vendor_name,
            buyer_name: e.buyer_name,
            vendor_gstin: e.vendor_gstin,
            buyer_gstin: e.buyer_gstin,
            invoice_number: e.invoice_number,
            invoice_number_norm: e.invoice_number_norm,
            invoice_date: e.invoice_date,
            place_of_supply: e.place_of_supply,
            currency: e.currency,
            exchange_rate: e.exchange_rate ?? null,
            tcs_amount: e.tcs_amount ?? null,
            tds_amount: e.tds_amount ?? null,
            pre_tax_charges: e.pre_tax_charges ?? null,
            round_off_amount: e.round_off_amount ?? null,
            irn: e.irn ?? null,
            ack_no: e.ack_no ?? null,
            eway_bill_no: e.eway_bill_no ?? null,
            gstin_auto_corrected: e.gstin_auto_corrected ?? false,
            validation_summary: e.validation_summary ?? null,
            taxable_amount: e.taxable_amount,
            discount_amount: e.discount_amount,
            cgst_amount: e.cgst_amount,
            sgst_amount: e.sgst_amount,
            igst_amount: e.igst_amount,
            cess_amount: e.cess_amount,
            total_amount: e.total_amount,
            confidence: e.confidence,
            document_type: e.document_type,
            review_flags: e.review_flags,
            field_status: e.field_status,
            raw_extraction: e.raw_extraction,
            extraction_model: e.extraction_model,
          }
        : null;
      const { data, error } = await admin.rpc("complete_extraction_job", {
        p_job_id: a.jobId,
        p_firm_id: a.firmId,
        p_outcome: a.outcome,
        p_extracted: extracted,
        p_items: a.items,
        p_attempts: a.attempts,
        p_error_code: a.errorCode,
      });
      if (error) throw new Error("complete_rpc_failed");
      const result = (data as { result?: string } | null)?.result;
      if (result === "ok" || result === "not_processing" || result === "not_found" || result === "invoice_removed") return result;
      throw new Error("complete_rpc_unexpected");
    },
  };
}

export function createSupabaseFiles(admin: SupabaseClient): FileSource {
  return {
    async download(path: string) {
      const { data, error } = await admin.storage.from("invoices").download(path);
      if (error || !data) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
