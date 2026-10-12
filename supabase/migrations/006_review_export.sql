-- AI Asis Phase 4: human review, verification, exports.
-- Prerequisite: the five earlier migrations have been applied. This file needs no enum changes, so it can run in one go.
--
-- Design notes
--  * Browsers still cannot write extracted_data or line_items. Corrections go through the server route
--    PUT /api/invoices/:id/review, which authorizes the user and then calls save_invoice_review() (service_role only).
--  * The original AI output stays in extracted_data.raw_extraction and is never changed. Header corrections are
--    recorded in extracted_data.corrected_fields (first original value kept) and in review_events (full history).
--  * 'verified' can only be set by save_invoice_review(); the existing guard_invoice_status trigger already blocks browsers.
--  * Export history is written by the server only.

-- ---------------------------------------------------------------------------
-- 1. extracted_data: correction tracking
-- ---------------------------------------------------------------------------
alter table public.extracted_data
  add column if not exists corrected_fields jsonb not null default '{}'::jsonb,
  add column if not exists items_edited boolean not null default false,
  add column if not exists edited_by uuid references auth.users (id) on delete set null,
  add column if not exists edited_at timestamptz;

alter table public.extracted_data
  add constraint extracted_data_corrected_is_object check (jsonb_typeof(corrected_fields) = 'object');

create index if not exists extracted_data_edited_by_idx on public.extracted_data (edited_by) where edited_by is not null;

-- ---------------------------------------------------------------------------
-- 2. review_events: audit trail of edits and verification
-- ---------------------------------------------------------------------------
create table public.review_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  invoice_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  action text not null check (action in ('edit', 'verify', 'unverify')),
  changes jsonb not null default '{}'::jsonb,
  acknowledged_flags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, firm_id) references public.invoices (id, firm_id) on delete cascade
);
create index review_events_firm_created_idx on public.review_events (firm_id, created_at desc);
create index review_events_invoice_idx on public.review_events (invoice_id, created_at desc);
create index review_events_user_idx on public.review_events (user_id);

alter table public.review_events enable row level security;
grant select on public.review_events to authenticated;
create policy review_events_select on public.review_events for select to authenticated
  using (public.is_firm_member(firm_id));

-- ---------------------------------------------------------------------------
-- 3. export_history: more detail, written by the server only
-- ---------------------------------------------------------------------------
alter table public.export_history
  add column if not exists profile text not null default 'standard',
  add column if not exists column_keys text[] not null default '{}',
  add column if not exists include_items boolean not null default false,
  add column if not exists file_name text,
  add column if not exists skipped_count int not null default 0 check (skipped_count >= 0),
  add column if not exists invoice_ids uuid[] not null default '{}';

revoke insert on public.export_history from authenticated;
drop policy if exists export_history_insert on public.export_history;

-- ---------------------------------------------------------------------------
-- 4. export_preferences: each user's saved column choice per firm
-- ---------------------------------------------------------------------------
create table public.export_preferences (
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  columns text[] not null default '{}' check (cardinality(columns) <= 60),
  item_columns text[] not null default '{}' check (cardinality(item_columns) <= 60),
  include_items boolean not null default false,
  date_format text not null default 'iso' check (date_format in ('iso', 'dmy')),
  updated_at timestamptz not null default now(),
  primary key (firm_id, user_id)
);
create index export_preferences_user_idx on public.export_preferences (user_id);

alter table public.export_preferences enable row level security;
grant select, insert, update on public.export_preferences to authenticated;

create policy export_preferences_select on public.export_preferences for select to authenticated
  using (user_id = (select auth.uid()) and public.is_firm_member(firm_id));
create policy export_preferences_insert on public.export_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_firm_member(firm_id));
create policy export_preferences_update on public.export_preferences for update to authenticated
  using (user_id = (select auth.uid()) and public.is_firm_member(firm_id))
  with check (user_id = (select auth.uid()) and public.is_firm_member(firm_id));

create trigger export_preferences_updated_at before update on public.export_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. invoice_review_list: one row per invoice for the dashboard table (search, sort, filter, export).
--    security_invoker = true, so Row Level Security of the caller applies to every joined table.
-- ---------------------------------------------------------------------------
create or replace view public.invoice_review_list
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
  e.igst_amount,
  e.cess_amount,
  case
    when e.cgst_amount is null and e.sgst_amount is null and e.igst_amount is null and e.cess_amount is null then null
    else coalesce(e.cgst_amount, 0) + coalesce(e.sgst_amount, 0) + coalesce(e.igst_amount, 0) + coalesce(e.cess_amount, 0)
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

-- ---------------------------------------------------------------------------
-- 6. review_summary(): counts and usage for the dashboard cards. SECURITY INVOKER: RLS decides what is counted.
-- ---------------------------------------------------------------------------
create or replace function public.review_summary(p_firm_id uuid)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'total', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status <> 'pending_deletion'),
    'processing', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status in ('uploaded', 'queued', 'processing')),
    'needs_review', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status in ('needs_review', 'completed')),
    'needs_review_flagged', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status = 'needs_review'),
    'verified', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status = 'verified'),
    'failed', (select count(*) from public.invoices i where i.firm_id = p_firm_id and i.status = 'failed'),
    'month_jobs', (
      select count(*) from public.processing_jobs j
      where j.firm_id = p_firm_id
        and j.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_succeeded', (
      select count(*) from public.processing_jobs j
      where j.firm_id = p_firm_id and j.status in ('completed', 'needs_review')
        and j.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_failed', (
      select count(*) from public.processing_jobs j
      where j.firm_id = p_firm_id and j.status = 'failed'
        and j.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_input_tokens', (
      select coalesce(sum(u.input_tokens), 0)::bigint from public.usage_records u
      where u.firm_id = p_firm_id and u.kind = 'extraction'
        and u.recorded_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_output_tokens', (
      select coalesce(sum(u.output_tokens), 0)::bigint from public.usage_records u
      where u.firm_id = p_firm_id and u.kind = 'extraction'
        and u.recorded_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_cost_usd', (
      select coalesce(sum(u.estimated_cost_usd), 0)::numeric(14, 6) from public.usage_records u
      where u.firm_id = p_firm_id and u.kind = 'extraction'
        and u.recorded_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_exports', (
      select count(*) from public.export_history h
      where h.firm_id = p_firm_id
        and h.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    ),
    'month_exported_invoices', (
      select coalesce(sum(h.invoice_count), 0)::bigint from public.export_history h
      where h.firm_id = p_firm_id
        and h.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
    )
  );
$$;

revoke all on function public.review_summary(uuid) from public, anon;
grant execute on function public.review_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. save_invoice_review(): one transaction for a human correction and/or verification. SERVER ONLY.
--    p_action: 'save' (store corrections, not verified), 'verify', 'unverify'.
--    p_header must carry every editable header column (the server merges the user's changes into the current row).
--    p_items: null = leave line items alone; an array replaces all items.
--    p_new_status: status used when the invoice is NOT verified afterwards: 'completed' or 'needs_review'.
--    Optimistic concurrency: p_expected_updated_at must equal extracted_data.updated_at, otherwise 'conflict'.
-- ---------------------------------------------------------------------------
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
      discount_amount, taxable_amount, gst_rate, gst_amount, line_total, field_status
    )
    select
      p_invoice_id, p_firm_id, t.ord::int,
      t.item ->> 'description', t.item ->> 'hsn_code',
      (t.item ->> 'quantity')::numeric, t.item ->> 'unit', (t.item ->> 'unit_price')::numeric,
      (t.item ->> 'discount_amount')::numeric, (t.item ->> 'taxable_amount')::numeric,
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

-- ---------------------------------------------------------------------------
-- 8. record_export(): writes export_history and the matching usage record in one transaction. SERVER ONLY.
-- ---------------------------------------------------------------------------
create or replace function public.record_export(
  p_firm_id uuid,
  p_user_id uuid,
  p_format text,
  p_profile text,
  p_invoice_ids uuid[],
  p_skipped int,
  p_column_keys text[],
  p_include_items boolean,
  p_file_name text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_format not in ('xlsx', 'csv') then
    raise exception 'invalid format' using errcode = '22023';
  end if;
  insert into public.export_history (
    firm_id, requested_by, format, invoice_count, profile, column_keys, include_items, file_name, skipped_count, invoice_ids
  ) values (
    p_firm_id, p_user_id, p_format, coalesce(cardinality(p_invoice_ids), 0), coalesce(p_profile, 'standard'),
    coalesce(p_column_keys, '{}'), coalesce(p_include_items, false), left(p_file_name, 200), greatest(coalesce(p_skipped, 0), 0),
    coalesce(p_invoice_ids, '{}')
  ) returning id into v_id;

  insert into public.usage_records (firm_id, user_id, kind, quantity, outcome)
  values (p_firm_id, p_user_id, 'export', 1, 'ok');

  return v_id;
end $$;

revoke all on function public.record_export(uuid, uuid, text, text, uuid[], int, text[], boolean, text) from public, anon, authenticated;
grant execute on function public.record_export(uuid, uuid, text, text, uuid[], int, text[], boolean, text) to service_role;
