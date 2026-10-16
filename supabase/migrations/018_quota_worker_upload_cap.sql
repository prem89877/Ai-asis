-- AI Asis Phase 5 (Part 4): three hardening fixes. Safe to run once, after 017_billing_period_anchor.sql. All functions are CREATE OR REPLACE.
--
-- Fix 1  stale_timeout / internal_error are no longer "free" failures.
--        Both can happen AFTER the Gemini call started (a function that dies mid-call, an exception while saving), and the provider
--        bills that call. They now consume the quota unit, exactly like invalid_model_output. A retry of the same invoice in the same
--        period still costs no second unit (one ledger row per invoice and period). Failures that happen before any AI call and are
--        clearly not the invoice's fault (provider_*, invoice_removed) stay free.
--        Backfill: ledger rows that were released for such a failure although a usage record proves the AI call happened become consumed.
--
-- Fix 2  background worker support. Stale jobs were only failed when a NEW claim for the SAME firm arrived, and queued jobs only ran when
--        the browser called /extract (close the tab and they stayed queued). reap_stale_extraction_jobs() fails stale jobs of ALL firms,
--        list_queued_extraction_jobs() returns the queued work in fair order. Both are called by /api/cron/extraction (see docs/OPERATIONS.md).
--
-- Fix 3  daily upload cap without a race. The route counted invoices and then inserted (check, then insert), so parallel uploads could pass
--        together, and deleting an invoice lowered the rolling count. Uploads now reserve a row in upload_events under a per-firm lock;
--        the count is taken from that table, so deleting invoices never gives a slot back.

-- ---------------------------------------------------------------------------
-- Fix 1: failure classification
-- ---------------------------------------------------------------------------
create or replace function public.is_free_failure(p_code text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_code, '') = any (array[
    'provider_unavailable', 'provider_timeout', 'provider_rate_limited',
    'provider_auth', 'provider_model_unavailable', 'invoice_removed'
  ]);
$$;
revoke all on function public.is_free_failure(text) from public, anon;
grant execute on function public.is_free_failure(text) to authenticated, service_role;

update public.usage_ledger l
   set state = 'consumed', updated_at = now()
 where l.state = 'released'
   and exists (
     select 1 from public.processing_jobs j
      where j.firm_id = l.firm_id and j.invoice_id = l.invoice_id
        and j.status::text = 'failed' and j.error_code in ('stale_timeout', 'internal_error')
        and j.created_at >= l.period_start and j.created_at < l.period_end
        and exists (select 1 from public.usage_records u where u.job_id = j.id)
   );

-- ---------------------------------------------------------------------------
-- Fix 2: worker helpers (service_role only)
-- ---------------------------------------------------------------------------
-- Fails every job that has been 'processing' longer than p_stale_seconds, for ALL firms. The ledger trigger settles the quota unit
-- (stale_timeout now consumes it). Takes the same per-firm lock as claim_extraction_job, firm by firm in a fixed order. Returns the number of jobs failed.
create or replace function public.reap_stale_extraction_jobs(p_stale_seconds int)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_firm uuid;
  v_n int;
  v_total int := 0;
begin
  for v_firm in
    select distinct j.firm_id
      from public.processing_jobs j
     where j.status = 'processing' and j.started_at < now() - make_interval(secs => p_stale_seconds)
     order by j.firm_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('extraction:' || v_firm::text, 0));
    with stale as (
      update public.processing_jobs j
         set status = 'failed', error_code = 'stale_timeout', finished_at = now()
       where j.firm_id = v_firm and j.status = 'processing'
         and j.started_at < now() - make_interval(secs => p_stale_seconds)
      returning j.invoice_id
    ), inv as (
      update public.invoices i
         set status = 'failed'
       where i.firm_id = v_firm and i.status = 'processing' and i.id in (select s.invoice_id from stale s)
      returning i.id
    )
    select count(*) into v_n from stale;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end $$;
revoke all on function public.reap_stale_extraction_jobs(int) from public, anon, authenticated;
grant execute on function public.reap_stale_extraction_jobs(int) to service_role;

-- Queued work for the worker, oldest first but fair between firms: the first job of every firm, then the second of every firm, ...
-- p_min_age_seconds leaves a just-queued job to the browser that queued it (the claim is atomic, so a clash is harmless anyway).
create or replace function public.list_queued_extraction_jobs(p_limit int, p_min_age_seconds int default 15)
returns table (job_id uuid, invoice_id uuid, firm_id uuid, requested_by uuid)
language sql stable security definer set search_path = '' as $$
  select r.id, r.invoice_id, r.firm_id, r.requested_by
    from (
      select j.id, j.invoice_id, j.firm_id, j.requested_by, j.created_at,
             row_number() over (partition by j.firm_id order by j.created_at, j.id) as rn
        from public.processing_jobs j
        join public.invoices i on i.id = j.invoice_id and i.firm_id = j.firm_id
       where j.status = 'queued' and i.status = 'queued'
         and j.created_at <= now() - make_interval(secs => greatest(p_min_age_seconds, 0))
    ) r
   order by r.rn, r.created_at, r.id
   limit greatest(p_limit, 0);
$$;
revoke all on function public.list_queued_extraction_jobs(int, int) from public, anon, authenticated;
grant execute on function public.list_queued_extraction_jobs(int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Fix 3: upload slots
-- ---------------------------------------------------------------------------
create table if not exists public.upload_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid,
  invoice_id uuid, -- intentionally no FK: the slot must survive deleting the invoice
  created_at timestamptz not null default now()
);
create index if not exists upload_events_firm_created_idx on public.upload_events (firm_id, created_at desc);
alter table public.upload_events enable row level security; -- no policies: only the server (service_role) reads or writes it
revoke all on table public.upload_events from anon, authenticated;

-- Carry over the last 24 hours so the cap does not reset on the day this is deployed.
insert into public.upload_events (firm_id, user_id, invoice_id, created_at)
select i.firm_id, i.uploaded_by, i.id, i.created_at
  from public.invoices i
 where i.created_at > now() - interval '24 hours'
   and not exists (select 1 from public.upload_events e where e.invoice_id = i.id);

-- Reserves one upload slot, atomically per firm: count and insert happen under one lock, so parallel uploads cannot pass together.
-- Returns {result: 'ok', id, used} or {result: 'limit', used}. The slot is counted from upload_events, never from invoices.
create or replace function public.reserve_upload_slot(p_firm_id uuid, p_user_id uuid, p_invoice_id uuid, p_limit int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_used int;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('upload:' || p_firm_id::text, 0));
  delete from public.upload_events where firm_id = p_firm_id and created_at < now() - interval '48 hours';
  select count(*) into v_used from public.upload_events where firm_id = p_firm_id and created_at >= now() - interval '24 hours';
  if v_used >= p_limit then
    return jsonb_build_object('result', 'limit', 'used', v_used);
  end if;
  insert into public.upload_events (firm_id, user_id, invoice_id) values (p_firm_id, p_user_id, p_invoice_id) returning id into v_id;
  return jsonb_build_object('result', 'ok', 'id', v_id, 'used', v_used + 1);
end $$;
revoke all on function public.reserve_upload_slot(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.reserve_upload_slot(uuid, uuid, uuid, int) to service_role;

-- Gives a slot back when the upload FAILED before an invoice existed (storage error, duplicate file). Server only, so a user cannot
-- release the slot of an upload that succeeded. An invoice that exists keeps its slot.
create or replace function public.release_upload_slot(p_firm_id uuid, p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.upload_events e
   where e.id = p_event_id and e.firm_id = p_firm_id
     and not exists (select 1 from public.invoices i where i.id = e.invoice_id);
end $$;
revoke all on function public.release_upload_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_upload_slot(uuid, uuid) to service_role;
