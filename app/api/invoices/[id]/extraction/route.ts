import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/invoices/validation";
import { userMessage } from "@/lib/extraction/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Extracted fields, line items, review flags and the latest job for one invoice.
// Reads go through the user's session, so Row Level Security decides what is visible.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) return json({ error: "No firm found for this account." }, 403);

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, original_filename, status, mime_type")
    .eq("id", params.id)
    .eq("firm_id", membership.firmId)
    .maybeSingle();
  if (!invoice || (invoice as { status: string }).status === "pending_deletion") return json({ error: "Not found." }, 404);

  const [extracted, items, job] = await Promise.all([
    supabase
      .from("extracted_data")
      .select(
        "vendor_name, buyer_name, vendor_gstin, buyer_gstin, invoice_number, invoice_date, place_of_supply, currency, taxable_amount, discount_amount, cgst_amount, sgst_amount, utgst_amount, igst_amount, cess_amount, total_amount, exchange_rate, tcs_amount, tds_amount, pre_tax_charges, round_off_amount, net_payable_amount, confidence, document_type, review_flags, field_status, extraction_model, extracted_at, updated_at, verified_at, edited_at, corrected_fields, items_edited"
      )
      .eq("invoice_id", params.id)
      .eq("firm_id", membership.firmId)
      .maybeSingle(),
    supabase
      .from("line_items")
      .select("position, description, hsn_code, quantity, unit, unit_price, discount_amount, taxable_amount, gst_rate, gst_amount, line_total, field_status")
      .eq("invoice_id", params.id)
      .eq("firm_id", membership.firmId)
      .order("position", { ascending: true }),
    supabase
      .from("processing_jobs")
      .select("status, error_code, attempts, queued_at, started_at, finished_at")
      .eq("invoice_id", params.id)
      .eq("firm_id", membership.firmId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Names of invoices flagged as possible duplicates, so the reviewer can open them.
  const flags = ((extracted.data as { review_flags?: { code: string; details?: { invoiceIds?: string[] } }[] } | null)?.review_flags ?? []);
  const dupIds = Array.from(new Set(flags.filter((f) => f.code === "possible_duplicate").flatMap((f) => f.details?.invoiceIds ?? []).filter((id) => UUID_RE.test(id)))).slice(0, 10);
  let duplicates: unknown[] = [];
  if (dupIds.length > 0) {
    const { data } = await supabase
      .from("invoice_review_list")
      .select("id, original_filename, invoice_number, vendor_name, invoice_date, total_amount, status")
      .eq("firm_id", membership.firmId)
      .in("id", dupIds);
    duplicates = data ?? [];
  }

  const jobRow = job.data as { status: string; error_code: string | null; attempts: number; queued_at: string; started_at: string | null; finished_at: string | null } | null;
  return json({
    invoice,
    extracted: extracted.data ?? null,
    items: items.data ?? [],
    duplicates,
    job: jobRow ? { ...jobRow, error_message: userMessage(jobRow.error_code) } : null,
  });
}
