-- AI Asis Phase 3 (2/2): extraction pipeline schema.
-- Prerequisite: 004_extraction_enums.sql has been run (and committed) first.
--
-- Design notes
--  * Extraction results, jobs and usage are written ONLY by trusted server code (service_role),
--    through the SECURITY DEFINER functions below. Browsers can read them (RLS) but not write them.
--  * Quotas, rate limits and the per-firm concurrency limit are enforced inside these functions,
--    under a per-firm advisory lock, so parallel requests cannot race past a limit.
--  * AI output is stored as "extracted", never as "verified". Only a later human review step may set 'verified'.

-- ---------------------------------------------------------------------------
-- 1. Batches: one multi-file upload. The declared size is enforced by a trigger.
-- ---------------------------------------------------------------------------
create table public.batches (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  file_count int not null check (file_count between 1 and 100),
  created_at timestamptz not null default now(),
  unique (id, firm_id)
);
create index batches_firm_created_idx on public.batches (firm_id, created_at desc);
create index batches_created_by_idx on public.batches (created_by);

alter table public.batches enable row level security;
grant select, insert on public.batches to authenticated;

create policy batches_select on public.batches for select to authenticated
  using (public.is_firm_member(firm_id));
create policy batches_insert on public.batches for insert to authenticated
  with check (public.is_firm_member(firm_id) and created_by = (select auth.uid()));

alter table public.invoices add column batch_id uuid;
alter table public.invoices
  add constraint invoices_batch_same_firm foreign key (batch_id, firm_id)
  references public.batches (id, firm_id) on delete set null (batch_id);
create index invoices_batch_idx on public.invoices (batch_id) where batch_id is not null;

-- An invoice may only be added to a batch that still has room. The batch row is locked
-- so two parallel uploads cannot both take the last slot.
create or replace function public.enforce_batch_capacity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_cap int;
  v_used int;
begin
  if new.batch_id is null then
    return new;
  end if;
  select b.file_count into v_cap
    from public.batches b
   where b.id = new.batch_id and b.firm_id = new.firm_id
     for update;
  if not found then
    raise exception 'batch_not_found' using errcode = '23503';
  end if;
  select count(*) into v_used from public.invoices i where i.batch_id = new.batch_id;
  if v_used >= v_cap then
    raise exception 'batch_full' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.enforce_batch_capacity() from public, anon, authenticated;

create trigger invoices_batch_capacity
  before insert on public.invoices
  for each row execute function public.enforce_batch_capacity();

-- ---------------------------------------------------------------------------
-- 2. Invoice status is managed by the server. A signed-in user may only mark an invoice
--    'pending_deletion' (the existing delete workflow); they cannot set 'completed' or 'verified'.
--    SECURITY DEFINER functions and service_role are unaffected (current_user is not authenticated).
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and current_user in ('authenticated', 'anon')
     and new.status <> 'pending_deletion' then
    raise exception 'invoice status is managed by the server' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_invoice_status() from public, anon, authenticated;

create trigger invoices_status_guard
  before update on public.invoices
  for each row execute function public.guard_invoice_status();

-- ---------------------------------------------------------------------------
-- 3. extracted_data: more fields, per-field status, raw model output.
-- ---------------------------------------------------------------------------
alter table public.extracted_data
  add column if not exists buyer_name text,
  add column if not exists place_of_supply text,
  add column if not exists discount_amount numeric(14, 2),
  add column if not exists cess_amount numeric(14, 2),
  add column if not exists document_type text,
  add column if not exists invoice_number_norm text,
  add column if not exists field_status jsonb not null default '{}'::jsonb,
  add column if not exists raw_extraction jsonb,
  add column if not exists extraction_model text,
  add column if not exists extracted_at timestamptz;

-- A missing currency must stay NULL. It is never defaulted to INR.
alter table public.extracted_data alter column currency drop not null;
alter table public.extracted_data alter column currency drop default;

alter table public.extracted_data
  add constraint extracted_data_flags_is_array check (jsonb_typeof(review_flags) = 'array');

create index if not exists extracted_data_dupe_number_idx
  on public.extracted_data (firm_id, invoice_number_norm) where invoice_number_norm is not null;
create index if not exists extracted_data_dupe_fingerprint_idx
  on public.extracted_data (firm_id, vendor_gstin, invoice_date)
  where vendor_gstin is not null and invoice_date is not null;

-- ---------------------------------------------------------------------------
-- 4. line_items: unit, discount, per-field status; unit_price keeps 4 decimals
--    so a printed price such as 12.3456 is not silently rounded.
-- ---------------------------------------------------------------------------
alter table public.line_items
  add column if not exists unit text,
  add column if not exists discount_amount numeric(14, 2),
  add column if not exists field_status jsonb not null default '{}'::jsonb;
alter table public.line_items alter column unit_price type numeric(14, 4);

-- Extraction output is written by the server only. Browsers keep read access.
revoke insert, update, delete on public.extracted_data from authenticated;
revoke insert, update, delete on public.line_items from authenticated;
drop policy if exists extracted_data_all on public.extracted_data;
drop policy if exists line_items_all on public.line_items;
create policy extracted_data_select on public.extracted_data for select to authenticated
  using (public.is_firm_member(firm_id));
create policy line_items_select on public.line_items for select to authenticated
  using (public.is_firm_member(firm_id));

-- ---------------------------------------------------------------------------
-- 5. processing_jobs and usage_records
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  add column if not exists requested_by uuid references auth.users (id) on delete set null;
create index if not exists processing_jobs_requested_by_idx on public.processing_jobs (requested_by);
create index if not exists processing_jobs_firm_created_idx on public.processing_jobs (firm_id, created_at desc);
-- At most one active (queued or processing) job per invoice.
create unique index if not exists processing_jobs_one_active_uidx
  on public.processing_jobs (invoice_id) where status in ('queued', 'processing');

alter table public.usage_records
  add column if not exists job_id uuid,
  add column if not exists model text,
  add column if not exists input_tokens int check (input_tokens is null or input_tokens >= 0),
  add column if not exists output_tokens int check (output_tokens is null or output_tokens >= 0),
  add column if not exists estimated_cost_usd numeric(12, 6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  add column if not exists outcome text;
create index if not exists usage_records_firm_recorded_idx on public.usage_records (firm_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 6. Server-only functions
-- ---------------------------------------------------------------------------

-- Queue invoices for extraction. Enforces: monthly quota, per-minute rate limit, runs per invoice.
-- Partial success: invoices that fit are queued, the rest are returned with a reason.
-- Jobs that failed only because of provider/server trouble do not consume monthly quota.
create or replace function public.enqueue_extraction_jobs(
  p_firm_id uuid,
  p_user_id uuid,
  p_invoice_ids uuid[],
  p_monthly_limit int,
  p_per_minute_limit int,
  p_max_runs int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv record;
  v_job_id uuid;
  v_month_used int;
  v_minute_used int;
  v_new int := 0;
  v_runs int;
  v_enqueued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if p_invoice_ids is null or coalesce(array_length(p_invoice_ids, 1), 0) = 0 then
    return jsonb_build_object('enqueued', v_enqueued, 'skipped', v_skipped);
  end if;
  if p_monthly_limit < 0 or p_per_minute_limit < 0 or p_max_runs < 1 then
    raise exception 'invalid limits' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));

  select count(*) into v_month_used
    from public.processing_jobs j
   where j.firm_id = p_firm_id
     and j.created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc')
     and not (
       j.status = 'failed'
       and coalesce(j.error_code, '') = any (array[
         'provider_unavailable', 'provider_timeout', 'provider_rate_limited',
         'provider_auth', 'provider_model_unavailable', 'stale_timeout', 'internal_error'
       ])
     );

  select count(*) into v_minute_used
    from public.processing_jobs j
   where j.firm_id = p_firm_id
     and j.created_at >= now() - interval '1 minute';

  for v_inv in
    select i.id, i.status
      from public.invoices i
     where i.firm_id = p_firm_id
       and i.id = any (p_invoice_ids)
     order by i.created_at, i.id
       for update
  loop
    if v_inv.status in ('queued', 'processing') then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'already_queued');
      continue;
    end if;
    if v_inv.status not in ('uploaded', 'failed') then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'not_eligible');
      continue;
    end if;

    select count(*) into v_runs from public.processing_jobs j where j.invoice_id = v_inv.id;
    if v_runs >= p_max_runs then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'max_runs_reached');
      continue;
    end if;
    if v_month_used + v_new >= p_monthly_limit then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'quota_exceeded');
      continue;
    end if;
    if v_minute_used + v_new >= p_per_minute_limit then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'rate_limited');
      continue;
    end if;

    insert into public.processing_jobs (invoice_id, firm_id, status, requested_by)
    values (v_inv.id, p_firm_id, 'queued', p_user_id)
    returning id into v_job_id;

    update public.invoices set status = 'queued' where id = v_inv.id and firm_id = p_firm_id;

    v_new := v_new + 1;
    v_enqueued := v_enqueued || jsonb_build_object('invoice_id', v_inv.id, 'job_id', v_job_id);
  end loop;

  return jsonb_build_object('enqueued', v_enqueued, 'skipped', v_skipped);
end $$;

-- Move the queued job of one invoice to 'processing'. Also fails jobs that have been
-- 'processing' longer than p_stale_seconds (a crashed or timed-out function) so they can be retried.
create or replace function public.claim_extraction_job(
  p_invoice_id uuid,
  p_firm_id uuid,
  p_max_concurrent int,
  p_stale_seconds int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv record;
  v_job record;
  v_active int;
begin
  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));

  with stale as (
    update public.processing_jobs j
       set status = 'failed', error_code = 'stale_timeout', finished_at = now()
     where j.firm_id = p_firm_id
       and j.status = 'processing'
       and j.started_at < now() - make_interval(secs => p_stale_seconds)
    returning j.invoice_id
  )
  update public.invoices i
     set status = 'failed'
   where i.firm_id = p_firm_id
     and i.status = 'processing'
     and i.id in (select s.invoice_id from stale s);

  select i.id, i.status, i.storage_path, i.mime_type, i.sha256
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.firm_id = p_firm_id
     for update;
  if not found or v_inv.status = 'pending_deletion' then
    return jsonb_build_object('result', 'not_found');
  end if;

  select j.id, j.status
    into v_job
    from public.processing_jobs j
   where j.invoice_id = p_invoice_id and j.firm_id = p_firm_id
   order by j.created_at desc, j.id desc
   limit 1
     for update;
  if not found then
    return jsonb_build_object('result', 'no_job');
  end if;
  if v_job.status = 'processing' then
    return jsonb_build_object('result', 'already_processing');
  end if;
  if v_job.status <> 'queued' then
    return jsonb_build_object('result', 'not_queued');
  end if;

  select count(*) into v_active
    from public.processing_jobs j
   where j.firm_id = p_firm_id and j.status = 'processing';
  if v_active >= p_max_concurrent then
    return jsonb_build_object('result', 'busy');
  end if;

  update public.processing_jobs
     set status = 'processing', started_at = now(), finished_at = null, attempts = 0, error_code = null
   where id = v_job.id;
  update public.invoices set status = 'processing' where id = p_invoice_id and firm_id = p_firm_id;

  return jsonb_build_object(
    'result', 'claimed',
    'job_id', v_job.id,
    'storage_path', v_inv.storage_path,
    'mime_type', v_inv.mime_type,
    'sha256', v_inv.sha256
  );
end $$;

-- Save the outcome of one job in a single transaction: extracted_data, line_items, job and invoice status.
-- p_outcome: 'completed' | 'needs_review' | 'failed'.
-- A job that is no longer 'processing' (for example already failed as stale) is never overwritten.
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
      taxable_amount, discount_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
      confidence, document_type, review_flags, field_status, raw_extraction, extraction_model,
      extracted_at, verified_by, verified_at
    ) values (
      v_job.invoice_id, p_firm_id,
      p_extracted ->> 'vendor_name', p_extracted ->> 'buyer_name',
      p_extracted ->> 'vendor_gstin', p_extracted ->> 'buyer_gstin',
      p_extracted ->> 'invoice_number', p_extracted ->> 'invoice_number_norm',
      (p_extracted ->> 'invoice_date')::date, p_extracted ->> 'place_of_supply', p_extracted ->> 'currency',
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
      discount_amount, taxable_amount, gst_rate, gst_amount, line_total, field_status
    )
    select
      v_job.invoice_id, p_firm_id, t.ord::int,
      t.item ->> 'description', t.item ->> 'hsn_code',
      (t.item ->> 'quantity')::numeric, t.item ->> 'unit', (t.item ->> 'unit_price')::numeric,
      (t.item ->> 'discount_amount')::numeric, (t.item ->> 'taxable_amount')::numeric,
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

-- Only the server (service_role) may call these.
revoke all on function public.enqueue_extraction_jobs(uuid, uuid, uuid[], int, int, int) from public, anon, authenticated;
revoke all on function public.claim_extraction_job(uuid, uuid, int, int) from public, anon, authenticated;
revoke all on function public.complete_extraction_job(uuid, uuid, text, jsonb, jsonb, int, text) from public, anon, authenticated;
grant execute on function public.enqueue_extraction_jobs(uuid, uuid, uuid[], int, int, int) to service_role;
grant execute on function public.claim_extraction_job(uuid, uuid, int, int) to service_role;
grant execute on function public.complete_extraction_job(uuid, uuid, text, jsonb, jsonb, int, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Usage and approximate cost per firm per month (members read it through RLS on usage_records).
-- ---------------------------------------------------------------------------
create or replace view public.extraction_usage_monthly
with (security_invoker = true) as
select
  u.firm_id,
  (date_trunc('month', u.recorded_at at time zone 'utc'))::date as month,
  count(*) as api_calls,
  count(distinct u.invoice_id) as invoices,
  coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
  coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
  coalesce(sum(u.estimated_cost_usd), 0)::numeric(14, 6) as estimated_cost_usd
from public.usage_records u
where u.kind = 'extraction'
group by 1, 2;

revoke all on public.extraction_usage_monthly from anon, authenticated;
grant select on public.extraction_usage_monthly to authenticated;
