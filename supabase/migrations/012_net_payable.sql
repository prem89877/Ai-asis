-- AI Asis: bottom-line summary field net_payable_amount (migration 012).
-- The invoice bottom summary has four fields the total check needs: tcs_amount (Sec 206C), tds_amount (Sec 194Q),
-- round_off_amount and net_payable_amount. The first three exist since migration 011; this adds net_payable_amount
-- (the amount payable AFTER the TDS deduction) and replaces complete_extraction_job() so the new column is written.
-- Run this migration BEFORE deploying the matching app code: the review route now selects net_payable_amount.
-- save_invoice_review() needs no change: it updates only the columns it lists, so the new column is left untouched on edit.

alter table public.extracted_data
  add column if not exists net_payable_amount numeric(14, 2);

create or replace function public.complete_extraction_job(
  p_job_id uuid,
  p_firm_id uuid,
  p_outcome text,
  p_extracted jsonb,
  p_items jsonb,
  p_attempts int,
  p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job record;
  v_inv_id uuid;
begin
  if p_outcome is null or p_outcome not in ('completed', 'needs_review', 'failed') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;

  select j.id, j.invoice_id, j.status
    into v_job
    from public.processing_jobs j
   where j.id = p_job_id and j.firm_id = p_firm_id
     for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_job.status <> 'processing' then
    return jsonb_build_object('result', 'not_processing');
  end if;

  select i.id into v_inv_id
    from public.invoices i
   where i.id = v_job.invoice_id and i.firm_id = p_firm_id and i.status <> 'pending_deletion'
     for update;
  if not found then
    update public.processing_jobs
       set status = 'failed', error_code = 'invoice_removed', finished_at = now(),
           attempts = greatest(coalesce(p_attempts, 0), 0)
     where id = p_job_id;
    return jsonb_build_object('result', 'invoice_removed');
  end if;

  if p_outcome in ('completed', 'needs_review') then
    if p_extracted is null or jsonb_typeof(p_extracted) <> 'object' then
      raise exception 'extracted payload required' using errcode = '22023';
    end if;

    insert into public.extracted_data (
      invoice_id, firm_id,
      vendor_name, buyer_name, vendor_gstin, buyer_gstin,
      invoice_number, invoice_number_norm, invoice_date, place_of_supply, currency,
      exchange_rate, tcs_amount, tds_amount, pre_tax_charges, round_off_amount, net_payable_amount, irn, ack_no, eway_bill_no, gstin_auto_corrected, validation_summary,
      taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
      confidence, document_type, review_flags, field_status, raw_extraction, extraction_model,
      extracted_at, verified_by, verified_at
    ) values (
      v_job.invoice_id, p_firm_id,
      p_extracted ->> 'vendor_name', p_extracted ->> 'buyer_name',
      p_extracted ->> 'vendor_gstin', p_extracted ->> 'buyer_gstin',
      p_extracted ->> 'invoice_number', p_extracted ->> 'invoice_number_norm',
      (p_extracted ->> 'invoice_date')::date, p_extracted ->> 'place_of_supply', p_extracted ->> 'currency',
      (p_extracted ->> 'exchange_rate')::numeric, (p_extracted ->> 'tcs_amount')::numeric, (p_extracted ->> 'tds_amount')::numeric,
      (p_extracted ->> 'pre_tax_charges')::numeric, (p_extracted ->> 'round_off_amount')::numeric, (p_extracted ->> 'net_payable_amount')::numeric,
      p_extracted ->> 'irn', p_extracted ->> 'ack_no', p_extracted ->> 'eway_bill_no',
      coalesce((p_extracted ->> 'gstin_auto_corrected')::boolean, false), p_extracted -> 'validation_summary',
      (p_extracted ->> 'taxable_amount')::numeric, (p_extracted ->> 'discount_amount')::numeric,
      (p_extracted ->> 'cgst_amount')::numeric, (p_extracted ->> 'sgst_amount')::numeric,
      (p_extracted ->> 'igst_amount')::numeric, (p_extracted ->> 'cess_amount')::numeric,
      (p_extracted ->> 'total_amount')::numeric,
      (p_extracted ->> 'confidence')::numeric, p_extracted ->> 'document_type',
      coalesce(p_extracted -> 'review_flags', '[]'::jsonb),
      coalesce(p_extracted -> 'field_status', '{}'::jsonb),
      p_extracted -> 'raw_extraction', p_extracted ->> 'extraction_model',
      now(), null, null
    )
    on conflict (invoice_id) do update set
      vendor_name = excluded.vendor_name,
      buyer_name = excluded.buyer_name,
      vendor_gstin = excluded.vendor_gstin,
      buyer_gstin = excluded.buyer_gstin,
      invoice_number = excluded.invoice_number,
      invoice_number_norm = excluded.invoice_number_norm,
      invoice_date = excluded.invoice_date,
      place_of_supply = excluded.place_of_supply,
      currency = excluded.currency,
      exchange_rate = excluded.exchange_rate,
      tcs_amount = excluded.tcs_amount,
      tds_amount = excluded.tds_amount,
      pre_tax_charges = excluded.pre_tax_charges,
      round_off_amount = excluded.round_off_amount,
      net_payable_amount = excluded.net_payable_amount,
      irn = excluded.irn,
      ack_no = excluded.ack_no,
      eway_bill_no = excluded.eway_bill_no,
      gstin_auto_corrected = excluded.gstin_auto_corrected,
      validation_summary = excluded.validation_summary,
      taxable_amount = excluded.taxable_amount,
      discount_amount = excluded.discount_amount,
      cgst_amount = excluded.cgst_amount,
      sgst_amount = excluded.sgst_amount,
      igst_amount = excluded.igst_amount,
      cess_amount = excluded.cess_amount,
      total_amount = excluded.total_amount,
      confidence = excluded.confidence,
      document_type = excluded.document_type,
      review_flags = excluded.review_flags,
      field_status = excluded.field_status,
      raw_extraction = excluded.raw_extraction,
      extraction_model = excluded.extraction_model,
      extracted_at = excluded.extracted_at,
      verified_by = null,
      verified_at = null;

    delete from public.line_items where invoice_id = v_job.invoice_id and firm_id = p_firm_id;

    insert into public.line_items (
      invoice_id, firm_id, "position", description, hsn_code, quantity, unit, unit_price,
      discount_amount, discount_type, applied_tax_type, taxable_amount, gst_rate, gst_amount, line_total, field_status
    )
    select
      v_job.invoice_id, p_firm_id, t.ord::int,
      t.item ->> 'description', t.item ->> 'hsn_code',
      (t.item ->> 'quantity')::numeric, t.item ->> 'unit', (t.item ->> 'unit_price')::numeric,
      (t.item ->> 'discount_amount')::numeric, t.item ->> 'discount_type', t.item ->> 'applied_tax_type',
      (t.item ->> 'taxable_amount')::numeric,
      (t.item ->> 'gst_rate')::numeric, (t.item ->> 'gst_amount')::numeric,
      (t.item ->> 'line_total')::numeric,
      coalesce(t.item -> 'field_status', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as t (item, ord);
  end if;

  update public.processing_jobs
     set status = p_outcome::public.job_status,
         error_code = case when p_outcome = 'failed' then coalesce(p_error_code, 'internal_error') else null end,
         attempts = greatest(coalesce(p_attempts, 0), 0),
         finished_at = now()
   where id = p_job_id;

  update public.invoices
     set status = p_outcome::public.invoice_status
   where id = v_inv_id and firm_id = p_firm_id;

  return jsonb_build_object('result', 'ok');
end $$;

revoke all on function public.complete_extraction_job(uuid, uuid, text, jsonb, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.complete_extraction_job(uuid, uuid, text, jsonb, jsonb, int, text) to service_role;
