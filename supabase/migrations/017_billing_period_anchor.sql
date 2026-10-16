-- AI Asis Phase 5 (Part 3): billing periods no longer drift at month end. Safe to run once, after 009_billing_fixes.sql.
--
-- Problem: roll_subscription_period() moved the period forward with  current_period_start + interval '1 month',  one step at a
-- time, so every step started from the PREVIOUS (already clamped) date: 31 Jan -> 28 Feb -> 28 Mar -> 28 Apr ... for ever.
-- Quota windows slid to the 28th and never came back.
--
-- Fix: every subscription keeps a fixed anchor (the moment its first period started). Period N always ends at
--   anchor + N months   (computed in UTC, from the anchor, never from the previous period)
-- so 31 Jan gives 28 Feb, 31 Mar, 30 Apr, 31 May ... Short months are clamped, long months go back to the anchor day.
--
-- Data: existing rows get anchor = their current period start (Pilot rows start on the 1st of a month, so nothing moves).
-- A row that had ALREADY drifted cannot be recovered automatically: set period_anchor by hand for such a firm.
-- Nothing else changes: same lock, same downgrade handling, same early return. CREATE OR REPLACE, so re-running is harmless.

alter table public.subscriptions add column if not exists period_anchor timestamptz;
update public.subscriptions set period_anchor = current_period_start where period_anchor is null;
alter table public.subscriptions alter column period_anchor set default now(); -- same transaction as the default period start, so they are equal
alter table public.subscriptions alter column period_anchor set not null;

-- anchor + N months in UTC. N is counted from the anchor, so a clamped month (28 Feb) never becomes the new day of month.
create or replace function public.add_billing_months(p_anchor timestamptz, p_months int)
returns timestamptz language sql immutable set search_path = '' as $$
  select ((p_anchor at time zone 'utc') + make_interval(months => p_months)) at time zone 'utc';
$$;
revoke all on function public.add_billing_months(timestamptz, int) from public, anon, authenticated;

create or replace function public.roll_subscription_period(p_firm_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
  v_from text;
  v_k int;
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

  -- How many months after the anchor does the current period end? (Month difference in UTC; a clamped end such as 28 Feb is still February.)
  v_k := ((extract(year from s.current_period_end at time zone 'utc') - extract(year from s.period_anchor at time zone 'utc')) * 12
        + (extract(month from s.current_period_end at time zone 'utc') - extract(month from s.period_anchor at time zone 'utc')))::int;

  while now() >= s.current_period_end loop
    s.current_period_start := s.current_period_end;
    v_k := v_k + 1;
    s.current_period_end := public.add_billing_months(s.period_anchor, v_k);
    -- Dates that were set by hand may not sit on the anchor's calendar: keep stepping until the end is after the start.
    while s.current_period_end <= s.current_period_start loop
      v_k := v_k + 1;
      s.current_period_end := public.add_billing_months(s.period_anchor, v_k);
    end loop;
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
