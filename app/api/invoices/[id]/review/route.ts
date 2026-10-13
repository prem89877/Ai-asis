import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/invoices/validation";
import { getCheckConfig } from "@/lib/extraction/config";
import { duplicateFlag } from "@/lib/extraction/pipeline";
import { createSupabaseStore } from "@/lib/extraction/store";
import type { FieldMeta, ReviewFlag, StoredItem } from "@/lib/extraction/types";
import { applyReview } from "@/lib/review/apply";
import { HEADER_COLUMNS, ITEM_FIELDS } from "@/lib/review/fields";
import type { HeaderValues } from "@/lib/review/fields";
import { computeReviewFlags, hasOpenFlags, toStoredExtracted } from "@/lib/review/flags";
import { parseReviewInput } from "@/lib/review/input";
import type { CorrectedField, CurrentRecord, StoredItemRow } from "@/lib/review/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADER_SELECT =
  "vendor_name, buyer_name, vendor_gstin, buyer_gstin, invoice_number, invoice_date, place_of_supply, currency, document_type, taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount, exchange_rate, tcs_amount, tds_amount, pre_tax_charges, round_off_amount, net_payable_amount, irn, ack_no, eway_bill_no, field_status, corrected_fields, updated_at";

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

// Saves a person's corrections, and/or marks the invoice verified (or removes verification).
//  1. authorize: same origin, session, firm from the database, invoice must belong to that firm
//  2. validate the body strictly (nothing is rounded or repaired)
//  3. merge into the current values, recompute every review flag, re-check duplicates
//  4. verifying while errors/warnings are open needs an explicit acknowledgement (acknowledgeFlags)
//  5. one database transaction (save_invoice_review) with an optimistic-concurrency check
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  const { firmId } = g.membership;

  const body = await readJsonBody(request, 256 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const parsed = parseReviewInput(body.value);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const input = parsed.value;

  const admin = createAdminClient();
  if (!admin) return json({ error: "Saving is not configured on this server." }, 503);

  // Everything below is scoped by firm_id.
  const { data: invoice } = await admin.from("invoices").select("id, status").eq("id", params.id).eq("firm_id", firmId).maybeSingle();
  if (!invoice) return json({ error: "Not found." }, 404);
  const status = (invoice as { status: string }).status;
  if (!["completed", "needs_review", "verified"].includes(status)) {
    return json({ error: "This invoice has no extracted data to review yet." }, 409);
  }

  const [headerRes, itemsRes] = await Promise.all([
    admin.from("extracted_data").select(HEADER_SELECT).eq("invoice_id", params.id).eq("firm_id", firmId).maybeSingle(),
    admin
      .from("line_items")
      .select("position, description, hsn_code, quantity, unit, unit_price, discount_amount, discount_type, applied_tax_type, taxable_amount, gst_rate, gst_amount, line_total, field_status")
      .eq("invoice_id", params.id)
      .eq("firm_id", firmId)
      .order("position", { ascending: true }),
  ]);
  if (headerRes.error || itemsRes.error) return json({ error: "The invoice could not be loaded. Try again." }, 500);
  const row = headerRes.data as Record<string, unknown> | null;
  if (!row) return json({ error: "This invoice has no extracted data to review yet." }, 409);

  // The page's copy must be the latest one. The exact string from the database is compared inside the transaction.
  if (String(row.updated_at) !== input.expectedUpdatedAt && new Date(String(row.updated_at)).getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
    return json({ error: "This invoice was changed by someone else. Reload it and apply your changes again.", code: "conflict" }, 409);
  }

  const currentHeader = {} as HeaderValues;
  for (const col of HEADER_COLUMNS) {
    const v = row[col];
    currentHeader[col] = ["taxable_amount", "discount_amount", "cgst_amount", "sgst_amount", "igst_amount", "cess_amount", "total_amount"].includes(col)
      ? numOrNull(v)
      : ((v as string | null) ?? null);
  }
  // Values the review screen does not edit but the GST checks need. Taken from the saved record, never from the browser.
  const extras = {
    exchange_rate: numOrNull(row.exchange_rate),
    tcs_amount: numOrNull(row.tcs_amount),
    tds_amount: numOrNull(row.tds_amount),
    pre_tax_charges: numOrNull(row.pre_tax_charges),
    round_off_amount: numOrNull(row.round_off_amount),
    net_payable_amount: numOrNull(row.net_payable_amount),
    irn: (row.irn as string | null) ?? null,
    ack_no: (row.ack_no as string | null) ?? null,
    eway_bill_no: (row.eway_bill_no as string | null) ?? null,
  };
  // Per-line labels (discount type, IGST vs CGST/SGST) are not editable here. They stay with their line while the
  // number of lines is unchanged; if lines were added or removed the labels cannot be matched and are dropped.
  const itemLabels = ((itemsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    discount_type: (r.discount_type as StoredItem["discount_type"]) ?? null,
    applied_tax_type: (r.applied_tax_type as StoredItem["applied_tax_type"]) ?? null,
  }));
  const currentItems: StoredItemRow[] = ((itemsRes.data ?? []) as Record<string, unknown>[]).map((r) => {
    const out = { field_status: (r.field_status ?? {}) as Record<string, FieldMeta> } as StoredItemRow;
    for (const f of ITEM_FIELDS) out[f.key] = f.kind === "amount" ? numOrNull(r[f.key]) : ((r[f.key] as string | null) ?? null);
    return out;
  });
  const current: CurrentRecord = {
    header: currentHeader,
    field_status: (row.field_status ?? {}) as Record<string, FieldMeta>,
    corrected_fields: (row.corrected_fields ?? {}) as Record<string, CorrectedField>,
    items: currentItems,
    updated_at: String(row.updated_at),
  };

  const nowIso = new Date().toISOString();
  const applied = applyReview(current, input, g.user.id, nowIso);
  const finalItems = applied.items ?? currentItems;

  const keepLabels = applied.items === null || applied.items.length === itemLabels.length;
  const labelFor = (idx: number) => (keepLabels ? itemLabels[idx] ?? { discount_type: null, applied_tax_type: null } : { discount_type: null, applied_tax_type: null });
  const storedItems: StoredItem[] = finalItems.map((it, idx) => ({
    ...labelFor(idx),
    description: it.description as string | null,
    hsn_code: it.hsn_code as string | null,
    quantity: it.quantity as number | null,
    unit: it.unit as string | null,
    unit_price: it.unit_price as number | null,
    discount_amount: it.discount_amount as number | null,
    taxable_amount: it.taxable_amount as number | null,
    gst_rate: it.gst_rate as number | null,
    gst_amount: it.gst_amount as number | null,
    line_total: it.line_total as number | null,
    field_status: it.field_status,
  }));

  const cfg = getCheckConfig();
  const flags: ReviewFlag[] = computeReviewFlags(applied.header, applied.fieldStatus, storedItems, cfg, new Date(), extras);

  // Duplicate candidates are re-checked against the corrected values.
  try {
    const stored = toStoredExtracted(applied.header, applied.fieldStatus, extras);
    const candidates = await createSupabaseStore(admin).findDuplicateCandidates({
      firmId,
      invoiceId: params.id,
      invoiceNumberNorm: applied.invoiceNumberNorm,
      vendorGstin: stored.vendor_gstin,
      invoiceDate: stored.invoice_date,
      totalAmount: stored.total_amount,
    });
    const dup = duplicateFlag(stored, candidates);
    if (dup) flags.push(dup);
  } catch {
    flags.push({ code: "duplicate_check_unavailable", severity: "warning", message: "The duplicate check could not run. Check manually for duplicates." });
  }

  const open = flags.filter((f) => f.severity === "error" || f.severity === "warning");
  if (input.action === "verify" && open.length > 0 && !input.acknowledgeFlags) {
    return json({ error: "This invoice still has open warnings. Confirm to verify it anyway.", code: "needs_acknowledgement", flags }, 409);
  }

  const headerPayload: Record<string, unknown> = { ...applied.header, invoice_number_norm: applied.invoiceNumberNorm };
  const { data, error } = await admin.rpc("save_invoice_review", {
    p_firm_id: firmId,
    p_invoice_id: params.id,
    p_user_id: g.user.id,
    // The browser's own copy, compared exactly (microseconds included) inside the transaction.
    p_expected_updated_at: input.expectedUpdatedAt,
    p_action: input.action,
    p_header: headerPayload,
    p_field_status: applied.fieldStatus,
    p_corrected: applied.corrected,
    p_items: applied.items ? applied.items.map((it, idx) => ({ ...it, ...labelFor(idx) })) : null,
    p_flags: flags,
    p_new_status: hasOpenFlags(flags) ? "needs_review" : "completed",
    p_changes: applied.changes,
    p_acknowledged: input.action === "verify" ? open.map((f) => ({ code: f.code, field: f.field ?? null, itemPosition: f.itemPosition ?? null })) : [],
  });
  if (error || !data) {
    console.error("review_save_failed", { invoiceId: params.id, code: error?.code ?? null });
    return json({ error: "The changes could not be saved. Try again." }, 500);
  }
  const result = data as { result: string; updated_at?: string; status?: string };
  switch (result.result) {
    case "ok":
      return json({ ok: true, status: result.status, updatedAt: result.updated_at, flags });
    case "conflict":
      return json({ error: "This invoice was changed by someone else. Reload it and apply your changes again.", code: "conflict" }, 409);
    case "not_editable":
    case "no_data":
      return json({ error: "This invoice cannot be edited right now." }, 409);
    default:
      return json({ error: "Not found." }, 404);
  }
}
