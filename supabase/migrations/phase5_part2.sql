-- AI Asis Phase 5 (Part 2): two fixes found while reviewing Part 1. Safe to run once, after phase5 part 1.
-- Both are CREATE OR REPLACE, so re-running is harmless. No data is changed.
--
-- Fix 1 (performance / contention): roll_subscription_period() took the firm-wide advisory lock on EVERY call,
--   and billing_overview() calls it on every dashboard load and every 5-second poll. That serialised the
--   dashboard with extraction claims for the same firm. It now returns early, without any lock, when the
--   billing period has not ended (the common case). The rollover itself is unchanged and still runs under the lock.
--
-- Fix 2 (quota loophole): deleting an invoice whose job was already 'processing' gave the quota unit back,
--   although the AI call had started (and may be billed by the provider). Only a job that never started
--   ('queued') releases its unit now; a 'processing' job is settled as consumed.

create or replace function public.roll_subscription_period(p_firm_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
  v_from text;
begin
  -- Cheap check first, no lock: nothing to do while the period is running or a payment provider owns the dates.
  if not exists (
    select 1 from public.subscriptions x
     where x.firm_id = p_firm_id and x.provider_subscription_id is null and now() >= x.current_period_end
  ) then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));
  select * into s from public.subscriptions where firm_id = p_firm_id for update;
  if not found or s.provider_subscription_id is not null or now() < s.current_period_end then
    return;
  end if;

  if s.pending_kind = 'downgrade' and s.pending_plan_code is not null then
    v_from := s.plan_code;
    s.plan_code := s.pending_plan_code;
    s.pending_plan_code := null;
    s.pending_kind := null;
    s.pending_effective_at := null;
    insert into public.billing_events (firm_id, event, from_plan, to_plan, detail)
    values (p_firm_id, 'downgrade_applied', v_from, s.plan_code, jsonb_build_object('at', s.current_period_end));
  end if;

  while now() >= s.current_period_end loop
    s.current_period_start := s.current_period_end;
    s.current_period_end := s.current_period_start + interval '1 month';
  end loop;

  update public.subscriptions
     set plan_code = s.plan_code,
         pending_plan_code = s.pending_plan_code,
         pending_kind = s.pending_kind,
         pending_effective_at = s.pending_effective_at,
         current_period_start = s.current_period_start,
         current_period_end = s.current_period_end
   where firm_id = p_firm_id;
end $$;
revoke all on function public.roll_subscription_period(uuid) from public, anon, authenticated;

create or replace function public.sync_usage_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_l public.usage_ledger%rowtype;
  v_job public.processing_jobs%rowtype;
  v_state text;
  v_other boolean;
begin
  if tg_op = 'DELETE' then
    -- Deleted before the AI started: give the unit back. Deleted while processing: the AI work began, so it counts.
    if old.status::text = 'queued' then
      update public.usage_ledger l
         set state = 'released', updated_at = now()
       where l.firm_id = old.firm_id and l.invoice_id = old.invoice_id and l.state = 'reserved'
         and l.period_start <= old.created_at and l.period_end > old.created_at;
    elsif old.status::text = 'processing' then
      update public.usage_ledger l
         set state = 'consumed', updated_at = now()
       where l.firm_id = old.firm_id and l.invoice_id = old.invoice_id and l.state = 'reserved'
         and l.period_start <= old.created_at and l.period_end > old.created_at;
    end if;
    return old;
  end if;

  v_job := new;
  if v_job.status is not distinct from old.status then
    return new;
  end if;
  if v_job.status::text not in ('completed', 'needs_review', 'failed', 'cancelled') then
    return new;
  end if;

  select * into v_l
    from public.usage_ledger l
   where l.firm_id = v_job.firm_id and l.invoice_id = v_job.invoice_id
     and l.period_start <= v_job.created_at and l.period_end > v_job.created_at
     for update;
  if not found then
    return new; -- job created before Phase 5; nothing to settle
  end if;

  if v_job.status::text in ('completed', 'needs_review') then
    v_state := 'consumed';
  elsif v_job.status::text = 'failed' and not public.is_free_failure(v_job.error_code) then
    v_state := 'consumed';
  else
    -- Free failure or cancelled: release, unless an earlier run of this invoice already did billable work.
    select exists (
      select 1 from public.processing_jobs j
       where j.firm_id = v_job.firm_id and j.invoice_id = v_job.invoice_id and j.id <> v_job.id
         and j.created_at >= v_l.period_start and j.created_at < v_l.period_end
         and (j.status::text in ('completed', 'needs_review')
              or (j.status::text = 'failed' and not public.is_free_failure(j.error_code)))
    ) into v_other;
    v_state := case when v_other then 'consumed' else 'released' end;
  end if;

  update public.usage_ledger set state = v_state, updated_at = now() where id = v_l.id;
  return new;
end $$;
revoke all on function public.sync_usage_ledger() from public, anon, authenticated;
