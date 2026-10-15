-- AI Asis: separate UTGST (Union Territory GST) amount (migration 014).
--
-- Problem: only sgst_amount existed ("SGST / UTGST"). An invoice that prints SGST and UTGST as two separate amounts lost one
-- of them, so CGST + SGST + IGST was lower than the real total GST and the total checks failed although the grand total was right.
--
-- Additive only. No existing column, row or user edit is changed or deleted.
--   * extracted_data.utgst_amount  numeric(14,2), nullable. NULL = "not printed / legacy row".
--   * line_items.applied_tax_type  also accepts 'CGST_UTGST'.
--   * complete_extraction_job() writes utgst_amount; save_invoice_review() updates it ONLY when the client sends it.
--   * invoice_review_list exposes utgst_amount and includes it in tax_total (total GST + cess, each head once).
-- Legacy rows: when utgst_amount is NULL, sgst_amount keeps its old meaning ("SGST / UTGST") and the app adds sgst + utgst, so
-- nothing is lost and nothing is counted twice. See lib/extraction/tax-components.ts.
-- Run this BEFORE deploying the matching app code (review, extraction and export routes select utgst_amount).

alter table public.extracted_data
  add column if not exists utgst_amount numeric(14, 2);

-- Widen the applied_tax_type check without touching data (the constraint name is generated, so it is looked up).
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and rel.relname = 'line_items' and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%applied_tax_type%'
  loop
    execute format('alter table public.line_items drop constraint %I', c.conname);
  end loop;
  alter table public.line_items
    add constraint line_items_applied_tax_type_check
    check (applied_tax_type is null or applied_tax_type in ('IGST', 'CGST_SGST', 'CGST_UTGST', 'NONE'));
end $$;

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
      exchange_rate, utgst_amount, tcs_amount, tds_amount, pre_tax_charges, round_off_amount, net_payable_amount, irn, ack_no, eway_bill_no, gstin_auto_corrected, validation_summary,
      taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
      confidence, document_type, review_flags, field_status, raw_extraction, extraction_model,
      extracted_at, verified_by, verified_at
    ) values (
      v_job.invoice_id, p_firm_id,
      p_extracted ->> 'vendor_name', p_extracted ->> 'buyer_name',
      p_extracted ->> 'vendor_gstin', p_extracted ->> 'buyer_gstin',
      p_extracted ->> 'invoice_number', p_extracted ->> 'invoice_number_norm',
      (p_extracted ->> 'invoice_date')::date, p_extracted ->> 'place_of_supply', p_extracted ->> 'currency',
      (p_extracted ->> 'exchange_rate')::numeric, (p_extracted ->> 'utgst_amount')::numeric, (p_extracted ->> 'tcs_amount')::numeric, (p_extracted ->> 'tds_amount')::numeric,
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
      utgst_amount = excluded.utgst_amount,
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

create or replace function public.save_invoice_review(
  p_firm_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_updated_at text,
  p_action text,
  p_header jsonb,
  p_field_status jsonb,
  p_corrected jsonb,
  p_items jsonb,
  p_flags jsonb,
  p_new_status text,
  p_changes jsonb,
  p_acknowledged jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv record;
  v_data record;
  v_new_updated timestamptz;
  v_status public.invoice_status;
begin
  if p_action is null or p_action not in ('save', 'verify', 'unverify') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_new_status is null or p_new_status not in ('completed', 'needs_review') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_header is null or jsonb_typeof(p_header) <> 'object'
     or p_field_status is null or jsonb_typeof(p_field_status) <> 'object'
     or p_corrected is null or jsonb_typeof(p_corrected) <> 'object'
     or p_flags is null or jsonb_typeof(p_flags) <> 'array' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid items' using errcode = '22023';
  end if;

  select i.id, i.status into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.firm_id = p_firm_id
     for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_inv.status not in ('completed', 'needs_review', 'verified') then
    return jsonb_build_object('result', 'not_editable');
  end if;

  select e.updated_at into v_data
    from public.extracted_data e
   where e.invoice_id = p_invoice_id and e.firm_id = p_firm_id
     for update;
  if not found then
    return jsonb_build_object('result', 'no_data');
  end if;
  if p_expected_updated_at is null or v_data.updated_at <> p_expected_updated_at::timestamptz then
    return jsonb_build_object('result', 'conflict', 'updated_at', v_data.updated_at);
  end if;

  update public.extracted_data set
    vendor_name = p_header ->> 'vendor_name',
    buyer_name = p_header ->> 'buyer_name',
    vendor_gstin = p_header ->> 'vendor_gstin',
    buyer_gstin = p_header ->> 'buyer_gstin',
    invoice_number = p_header ->> 'invoice_number',
    invoice_number_norm = p_header ->> 'invoice_number_norm',
    invoice_date = (p_header ->> 'invoice_date')::date,
    place_of_supply = p_header ->> 'place_of_supply',
    currency = p_header ->> 'currency',
    document_type = coalesce(p_header ->> 'document_type', document_type),
    taxable_amount = (p_header ->> 'taxable_amount')::numeric,
    discount_amount = (p_header ->> 'discount_amount')::numeric,
    cgst_amount = (p_header ->> 'cgst_amount')::numeric,
    sgst_amount = (p_header ->> 'sgst_amount')::numeric,
    -- Only written when the client sent it, so an older browser tab can never wipe a stored UTGST.
    utgst_amount = case when p_header ? 'utgst_amount' then (p_header ->> 'utgst_amount')::numeric else utgst_amount end,
    igst_amount = (p_header ->> 'igst_amount')::numeric,
    cess_amount = (p_header ->> 'cess_amount')::numeric,
    total_amount = (p_header ->> 'total_amount')::numeric,
    field_status = p_field_status,
    corrected_fields = p_corrected,
    review_flags = p_flags,
    items_edited = items_edited or (p_items is not null),
    edited_by = case when p_action = 'unverify' then edited_by else p_user_id end,
    edited_at = case when p_action = 'unverify' then edited_at else now() end,
    verified_by = case when p_action = 'verify' then p_user_id else null end,
    verified_at = case when p_action = 'verify' then now() else null end
  where invoice_id = p_invoice_id and firm_id = p_firm_id
  returning updated_at into v_new_updated;

  if p_items is not null then
    delete from public.line_items where invoice_id = p_invoice_id and firm_id = p_firm_id;
    insert into public.line_items (
      invoice_id, firm_id, "position", description, hsn_code, quantity, unit, unit_price,
      discount_amount, discount_type, applied_tax_type, taxable_amount, gst_rate, gst_amount, line_total, field_status
    )
    select
      p_invoice_id, p_firm_id, t.ord::int,
      t.item ->> 'description', t.item ->> 'hsn_code',
      (t.item ->> 'quantity')::numeric, t.item ->> 'unit', (t.item ->> 'unit_price')::numeric,
      (t.item ->> 'discount_amount')::numeric, t.item ->> 'discount_type', t.item ->> 'applied_tax_type',
      (t.item ->> 'taxable_amount')::numeric,
      (t.item ->> 'gst_rate')::numeric, (t.item ->> 'gst_amount')::numeric,
      (t.item ->> 'line_total')::numeric,
      coalesce(t.item -> 'field_status', '{}'::jsonb)
    from jsonb_array_elements(p_items) with ordinality as t (item, ord);
  end if;

  v_status := case when p_action = 'verify' then 'verified' else p_new_status end::public.invoice_status;
  update public.invoices set status = v_status where id = p_invoice_id and firm_id = p_firm_id;

  insert into public.review_events (firm_id, invoice_id, user_id, action, changes, acknowledged_flags)
  values (
    p_firm_id, p_invoice_id, p_user_id,
    case p_action when 'save' then 'edit' else p_action end,
    coalesce(p_changes, '{}'::jsonb),
    coalesce(p_acknowledged, '[]'::jsonb)
  );

  return jsonb_build_object('result', 'ok', 'updated_at', v_new_updated, 'status', v_status);
end $$;

revoke all on function public.save_invoice_review(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_invoice_review(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb, jsonb) to service_role;

-- A column cannot be inserted in the middle of an existing view, so it is recreated (a view holds no data).
drop view if exists public.invoice_review_list;
create view public.invoice_review_list
with (security_invoker = true) as
select
  i.id,
  i.firm_id,
  i.original_filename,
  i.mime_type,
  i.size_bytes,
  i.status,
  i.created_at,
  i.batch_id,
  e.vendor_name,
  e.vendor_gstin,
  e.buyer_name,
  e.buyer_gstin,
  e.invoice_number,
  e.invoice_date,
  e.place_of_supply,
  e.currency,
  e.document_type,
  e.taxable_amount,
  e.discount_amount,
  e.cgst_amount,
  e.sgst_amount,
  e.utgst_amount,
  e.igst_amount,
  e.cess_amount,
  case
    when e.cgst_amount is null and e.sgst_amount is null and e.utgst_amount is null and e.igst_amount is null and e.cess_amount is null then null
    else coalesce(e.cgst_amount, 0) + coalesce(e.sgst_amount, 0) + coalesce(e.utgst_amount, 0) + coalesce(e.igst_amount, 0) + coalesce(e.cess_amount, 0)
  end as tax_total,
  e.total_amount,
  e.confidence,
  e.review_flags,
  e.verified_at,
  e.edited_at,
  e.updated_at as data_updated_at,
  coalesce(jsonb_array_length(e.review_flags), 0) as flag_count,
  (select count(*) from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f where f ->> 'severity' = 'error') as error_count,
  (select count(*) from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f where f ->> 'severity' = 'warning') as warning_count,
  array(select distinct f ->> 'code' from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f) as flag_codes,
  -- "code" and "code:field" for every flag, so the UI can filter on e.g. missing_field:supplier_gstin.
  array(
    select distinct k
    from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f,
         lateral unnest(
           case when f ->> 'field' is null then array[f ->> 'code']
                else array[f ->> 'code', (f ->> 'code') || ':' || (f ->> 'field')] end
         ) as k
  ) as flag_keys,
  j.status::text as job_status,
  j.error_code as job_error_code
from public.invoices i
left join public.extracted_data e on e.invoice_id = i.id and e.firm_id = i.firm_id
left join lateral (
  select pj.status, pj.error_code
  from public.processing_jobs pj
  where pj.invoice_id = i.id and pj.firm_id = i.firm_id
  order by pj.created_at desc, pj.id desc
  limit 1
) j on true
where i.status <> 'pending_deletion';

revoke all on public.invoice_review_list from anon, authenticated;
grant select on public.invoice_review_list to authenticated;

-- OPTIONAL backfill, NOT run automatically (it would change stored values). Review the SELECT, then run the UPDATE yourself.
-- Moves the state-level amount of a legacy invoice into utgst_amount only when the supplier GSTIN is in a UT without a
-- legislature (04, 26, 31, 35, 38), the invoice is CGST + state tax with no IGST, and no UTGST was stored.
-- select invoice_id, vendor_gstin, cgst_amount, sgst_amount from public.extracted_data
--  where utgst_amount is null and substr(vendor_gstin, 1, 2) in ('04','26','31','35','38')
--    and coalesce(cgst_amount, 0) > 0 and coalesce(sgst_amount, 0) > 0 and coalesce(igst_amount, 0) = 0;
-- update public.extracted_data set utgst_amount = sgst_amount, sgst_amount = null
--  where utgst_amount is null and substr(vendor_gstin, 1, 2) in ('04','26','31','35','38')
--    and coalesce(cgst_amount, 0) > 0 and coalesce(sgst_amount, 0) > 0 and coalesce(igst_amount, 0) = 0;
