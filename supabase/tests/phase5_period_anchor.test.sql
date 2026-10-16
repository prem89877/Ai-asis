-- AI Asis Phase 5 (Part 3): billing period month-end drift (migration 017). Plain SQL, one transaction, rolled back.
-- HOW TO RUN (scratch / local database only):  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_period_anchor.test.sql
-- Prerequisite: migrations up to 017_billing_period_anchor.sql are applied.
-- STATUS: written, NOT executed (no PostgreSQL in the build environment). Expect small fixes on the first run.
begin;

do $$
declare
  a timestamptz := '2026-01-31 10:00:00+00';
begin
  -- the anchor day comes back after a short month (the old chained '+ 1 month' stayed on the 28th for ever)
  if public.add_billing_months(a, 1) <> '2026-02-28 10:00:00+00' then raise exception 'TEST FAILED: 31 Jan + 1 month = 28 Feb'; end if;
  if public.add_billing_months(a, 2) <> '2026-03-31 10:00:00+00' then raise exception 'TEST FAILED: 31 Jan + 2 months = 31 Mar (no drift)'; end if;
  if public.add_billing_months(a, 3) <> '2026-04-30 10:00:00+00' then raise exception 'TEST FAILED: 31 Jan + 3 months = 30 Apr'; end if;
  if public.add_billing_months(a, 13) <> '2027-02-28 10:00:00+00' then raise exception 'TEST FAILED: 31 Jan + 13 months = 28 Feb next year'; end if;
  if public.add_billing_months('2028-01-31 10:00:00+00', 1) <> '2028-02-29 10:00:00+00' then raise exception 'TEST FAILED: leap year'; end if;
  raise notice 'PASS: add_billing_months does not drift';
end $$;

-- roll_subscription_period: a subscription anchored on 31 Jan, two months late, lands on 31 Mar (not 28 Mar)
do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000d0001';
  f uuid;
  e timestamptz;
begin
  insert into auth.users (id, email) values (u, 'anchor@test.invalid');
  select m.firm_id into f from public.firm_members m where m.user_id = u limit 1;
  update public.subscriptions
     set period_anchor = '2026-01-31 10:00:00+00', current_period_start = '2026-01-31 10:00:00+00', current_period_end = '2026-02-28 10:00:00+00'
   where firm_id = f;
  -- now() is far past 2026-03; the loop must keep the 31st wherever the month allows it
  perform public.roll_subscription_period(f);
  select current_period_end into e from public.subscriptions where firm_id = f;
  if e <= now() then raise exception 'TEST FAILED: the period moved forward past now()'; end if;
  if extract(day from e at time zone 'utc') <> least(31, extract(day from (date_trunc('month', e at time zone 'utc') + interval '1 month - 1 day'))) then
    raise exception 'TEST FAILED: period end is not on the anchor day (or the last day of a short month): %', e;
  end if;
  if (select current_period_end <= current_period_start from public.subscriptions where firm_id = f) then raise exception 'TEST FAILED: period order'; end if;
  raise notice 'PASS: rollover keeps the anchor day';
end $$;

rollback;
select 'PHASE 5 PERIOD ANCHOR TESTS PASSED' as result;
