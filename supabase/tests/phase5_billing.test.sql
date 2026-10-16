-- AI Asis Phase 5: database tests for plans, subscriptions, quota ledger, plan changes and tenant isolation (plain SQL).
--
-- HOW TO RUN (scratch / local Supabase database only, never production data):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_billing.test.sql
--   or paste the whole file into the Supabase SQL Editor and run it once.
-- Prerequisite: all earlier migrations plus 008_billing.sql AND 009_billing_fixes.sql are applied.
-- Everything runs in one transaction that is rolled back, so no test data is kept (plan limits changed by the
-- tests are restored too). The last output is one row "PHASE 5 SQL TESTS PASSED". A failed check stops the script
-- with "TEST FAILED: <name>"; then run:  rollback;
-- STATUS: written, NOT executed (no PostgreSQL in the build environment). Expect small fixes on the first run.

begin;

create function public._t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;
create function public._t_user(p_id uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_firm uuid;
begin
  -- The signup trigger creates the profile, a personal firm, the owner membership and (Phase 5) a Pilot subscription.
  insert into auth.users (id, email) values (p_id, p_id::text || '@test.invalid');
  select m.firm_id into v_firm from public.firm_members m where m.user_id = p_id limit 1;
  return v_firm;
end $$;
create function public._t_firm(p_user uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select m.firm_id from public.firm_members m where m.user_id = p_user order by m.created_at limit 1;
$$;
create function public._t_inv(p_id uuid, p_firm uuid, p_status text default 'uploaded') returns uuid language plpgsql security definer set search_path = '' as $$
begin
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values (p_id, p_firm, p_firm::text || '/' || p_id::text || '.pdf', 'test.pdf', 'application/pdf', 1000,
          encode(sha256(convert_to(p_id::text, 'utf8')), 'hex'), p_status::public.invoice_status);
  return p_id;
end $$;
-- Quota units held (reserved or consumed) by a firm in its current period.
create function public._t_used(p_firm uuid) returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.usage_ledger l join public.subscriptions s on s.firm_id = l.firm_id and s.current_period_start = l.period_start
   where l.firm_id = p_firm and l.state <> 'released';
$$;
-- Move a queued job through processing to an outcome, the way the extraction pipeline does.
create function public._t_finish(p_invoice uuid, p_status text, p_error text default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_job uuid;
begin
  -- Prefer the ACTIVE (queued / processing) job: inside one test transaction every job has the same created_at (now()), so ordering by
  -- time alone can pick an old failed job and move it back to 'processing' while the retry job is still active (unique index violation).
  select j.id into v_job from public.processing_jobs j where j.invoice_id = p_invoice
   order by (j.status::text in ('queued', 'processing')) desc, j.created_at desc, j.id desc limit 1;
  update public.processing_jobs set status = 'processing', started_at = now() where id = v_job;
  update public.invoices set status = 'processing' where id = p_invoice;
  update public.processing_jobs
     set status = p_status::public.job_status, error_code = p_error, finished_at = now() where id = v_job;
  update public.invoices set status = case p_status when 'failed' then 'failed' else p_status end::public.invoice_status where id = p_invoice;
end $$;
grant execute on function public._t_assert(boolean, text) to anon, authenticated, service_role;
grant execute on function public._t_firm(uuid) to anon, authenticated, service_role;

select public._t_user('00000000-0000-4000-8000-0000000c0001'::uuid) as firm_a, public._t_user('00000000-0000-4000-8000-0000000c0002'::uuid) as firm_b;
-- A third user who is only a MEMBER (not owner or admin) of firm A.
select public._t_user('00000000-0000-4000-8000-0000000c0003'::uuid);
insert into public.firm_members (firm_id, user_id, role)
values (public._t_firm('00000000-0000-4000-8000-0000000c0001'), '00000000-0000-4000-8000-0000000c0003', 'member');

-- ---------------------------------------------------------------- 1. seed and defaults
do $$
begin
  perform public._t_assert((select count(*) from public.plans where code in ('pilot', 'solo', 'ca_firm')) = 3, 'the three proposed plans are seeded');
  perform public._t_assert((select price_paise = 79900 from public.plans where code = 'solo'), 'Solo is proposed at INR 799 (paise)');
  perform public._t_assert((select price_paise = 149900 and price_max_paise = 299900 from public.plans where code = 'ca_firm'), 'CA Firm has a price range');
  perform public._t_assert((select plan_code = 'pilot' and status = 'active' from public.subscriptions where firm_id = public._t_firm('00000000-0000-4000-8000-0000000c0001')), 'a new firm starts on an active Pilot subscription');
  perform public._t_assert((select count(*) from public.subscriptions where firm_id = public._t_firm('00000000-0000-4000-8000-0000000c0002')) = 1, 'every firm has exactly one subscription');
end $$;

-- ---------------------------------------------------------------- 2. quota limit (limits come from the plan row)
update public.plans set monthly_invoice_limit = 3 where code = 'pilot';   -- rolled back at the end
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  ua uuid := '00000000-0000-4000-8000-0000000c0001';
  r jsonb;
begin
  perform public._t_inv(('00000000-0000-4000-8000-0000000c10' || lpad(i::text, 2, '0'))::uuid, fa) from generate_series(1, 5) i;
  r := public.enqueue_metered_jobs(fa, ua, array(select ('00000000-0000-4000-8000-0000000c10' || lpad(i::text, 2, '0'))::uuid from generate_series(1, 5) i), 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 3, 'only as many invoices as the plan quota are queued');
  perform public._t_assert((select count(*) from jsonb_array_elements(r -> 'skipped') s where s ->> 'reason' = 'quota_exceeded') = 2, 'the rest are skipped with quota_exceeded');
  perform public._t_assert((r -> 'quota' ->> 'used')::int = 3 and (r -> 'quota' ->> 'remaining')::int = 0, 'the answer reports used and remaining quota');
  perform public._t_assert(public._t_used(fa) = 3, 'the ledger holds three units');
  perform public._t_assert((select count(*) from public.invoices where firm_id = fa and status = 'uploaded') = 2, 'skipped invoices stay uploaded');
  r := public.enqueue_metered_jobs(fa, ua, array['00000000-0000-4000-8000-0000000c1004']::uuid[], 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0 and r -> 'skipped' -> 0 ->> 'reason' = 'quota_exceeded', 'a full quota queues nothing more');
end $$;

-- ---------------------------------------------------------------- 3. a retry costs no extra unit
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  ua uuid := '00000000-0000-4000-8000-0000000c0001';
  r jsonb;
begin
  perform public._t_finish('00000000-0000-4000-8000-0000000c1001', 'failed', 'invalid_model_output');   -- the invoice's own fault
  perform public._t_assert((select state from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1001') = 'consumed', 'a failure caused by the invoice consumes the unit');
  r := public.enqueue_metered_jobs(fa, ua, array['00000000-0000-4000-8000-0000000c1001']::uuid[], 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'the failed invoice can be retried even though the quota is full');
  perform public._t_assert((r -> 'quota' ->> 'used')::int = 3 and public._t_used(fa) = 3, 'the retry did not use a second unit');
  perform public._t_assert((select count(*) from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1001') = 1, 'still one ledger row for that invoice and period');
end $$;

-- ---------------------------------------------------------------- 4. a provider failure releases the unit
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  ua uuid := '00000000-0000-4000-8000-0000000c0001';
  r jsonb;
begin
  perform public._t_finish('00000000-0000-4000-8000-0000000c1002', 'failed', 'provider_unavailable');   -- not the invoice's fault
  perform public._t_assert((select state from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1002') = 'released', 'a provider failure releases the unit');
  perform public._t_assert(public._t_used(fa) = 2, 'the released unit is available again');
  r := public.enqueue_metered_jobs(fa, ua, array['00000000-0000-4000-8000-0000000c1004']::uuid[], 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'the freed unit can be used by another invoice');
  perform public._t_assert(public._t_used(fa) = 3, 'quota is full again');
  r := public.enqueue_metered_jobs(fa, ua, array['00000000-0000-4000-8000-0000000c1002']::uuid[], 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0 and r -> 'skipped' -> 0 ->> 'reason' = 'quota_exceeded', 'retrying the released invoice needs a free unit again');
end $$;

-- ---------------------------------------------------------------- 5. deleting an invoice does not return quota
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  before_n int;
begin
  perform public._t_finish('00000000-0000-4000-8000-0000000c1001', 'completed');
  before_n := public._t_used(fa);
  delete from public.invoices where id = '00000000-0000-4000-8000-0000000c1001';
  perform public._t_assert(public._t_used(fa) = before_n, 'deleting a processed invoice does not give the unit back');
  perform public._t_assert((select state from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1001') = 'consumed', 'its ledger row survives and stays consumed');

  -- c1003 is still queued: the AI never started, so deleting it releases the unit.
  delete from public.invoices where id = '00000000-0000-4000-8000-0000000c1003';
  perform public._t_assert((select state from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1003') = 'released', 'deleting an invoice that never started releases its unit');

  -- c1004 is queued; make its job "processing" (the AI call started), then delete: the unit counts as used.
  update public.processing_jobs set status = 'processing', started_at = now() where invoice_id = '00000000-0000-4000-8000-0000000c1004';
  before_n := public._t_used(fa);
  delete from public.invoices where id = '00000000-0000-4000-8000-0000000c1004';
  perform public._t_assert((select state from public.usage_ledger where invoice_id = '00000000-0000-4000-8000-0000000c1004') = 'consumed', 'deleting an invoice while the AI is running keeps the unit consumed');
  perform public._t_assert(public._t_used(fa) = before_n, 'used quota did not go down');
end $$;

-- ---------------------------------------------------------------- 6. batch limit trigger (the database enforces the plan's batch size)
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  ok boolean := false;
begin
  insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-0000000c0001', 5);
  perform public._t_assert(true, 'a batch within the plan limit is accepted');
  begin
    insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-0000000c0001', 6);
  exception when check_violation then ok := true; end;
  perform public._t_assert(ok, 'a batch above the plan limit is rejected');
  perform public._t_assert(public.enqueue_metered_jobs(fa, '00000000-0000-4000-8000-0000000c0001', array(select gen_random_uuid() from generate_series(1, 6)), 100, 5) ->> 'error' = 'batch_limit', 'enqueue refuses more invoices than the plan batch limit');
end $$;

-- ---------------------------------------------------------------- 7. plan changes: roles, upgrade, downgrade, cancel
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  owner_id uuid := '00000000-0000-4000-8000-0000000c0001';
  member_id uuid := '00000000-0000-4000-8000-0000000c0003';
  r jsonb;
begin
  r := public.change_plan(fa, member_id, 'solo', true);
  perform public._t_assert(r ->> 'result' = 'forbidden', 'a member cannot change the plan');
  perform public._t_assert((select plan_code from public.subscriptions where firm_id = fa) = 'pilot', 'the plan is unchanged after a forbidden request');
  r := public.change_plan(fa, '00000000-0000-4000-8000-0000000c0002', 'solo', true);
  perform public._t_assert(r ->> 'result' = 'forbidden', 'the owner of another firm cannot change this firm''s plan');

  r := public.change_plan(fa, owner_id, 'does_not_exist', false);
  perform public._t_assert(r ->> 'result' = 'unknown_plan', 'an unknown plan is rejected');

  r := public.change_plan(fa, owner_id, 'solo', false);
  perform public._t_assert(r ->> 'result' = 'payment_required', 'an upgrade without the test flag waits for payment');
  perform public._t_assert((select plan_code = 'pilot' and pending_plan_code = 'solo' and pending_kind = 'upgrade_awaiting_payment' from public.subscriptions where firm_id = fa), 'the plan does NOT change before payment');

  r := public.change_plan(fa, owner_id, 'pilot', false);
  perform public._t_assert(r ->> 'result' = 'pending_cancelled' and (select pending_plan_code is null from public.subscriptions where firm_id = fa), 'choosing the current plan cancels the pending change');

  r := public.change_plan(fa, owner_id, 'solo', true);
  perform public._t_assert(r ->> 'result' = 'upgraded' and (select plan_code = 'solo' from public.subscriptions where firm_id = fa), 'with the test flag an upgrade applies immediately');
  perform public._t_assert((select p.monthly_invoice_limit from public.subscriptions s join public.plans p on p.code = s.plan_code where s.firm_id = fa) = (select monthly_invoice_limit from public.plans where code = 'solo'), 'the quota follows the new plan');

  r := public.change_plan(fa, owner_id, 'pilot', false);
  perform public._t_assert(r ->> 'result' = 'downgrade_scheduled' and (select plan_code = 'solo' and pending_kind = 'downgrade' from public.subscriptions where firm_id = fa), 'a downgrade is scheduled, the current plan stays active');
  perform public._t_assert((select pending_effective_at = current_period_end from public.subscriptions where firm_id = fa), 'the downgrade takes effect at the end of the period');
  perform public._t_assert((select count(*) from public.billing_events where firm_id = fa) >= 4, 'plan changes are written to billing_events');

  -- the period ends: the downgrade is applied and usage starts again from zero
  update public.subscriptions set current_period_start = now() - interval '40 days', current_period_end = now() - interval '10 days', pending_effective_at = now() - interval '10 days' where firm_id = fa;
  perform public.roll_subscription_period(fa);
  perform public._t_assert((select plan_code = 'pilot' and pending_plan_code is null and current_period_end > now() from public.subscriptions where firm_id = fa), 'at the period end the downgrade is applied and the period moves forward');
  perform public._t_assert(public._t_used(fa) = 0, 'a new period starts with zero used');
end $$;

-- ---------------------------------------------------------------- 8. tenant isolation (firm B user looks at firm A)
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000c0002', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  fb uuid := public._t_firm('00000000-0000-4000-8000-0000000c0002');
begin
  perform public._t_assert((select count(*) from public.subscriptions) = 1 and not exists (select 1 from public.subscriptions where firm_id = fa), 'a user sees only their own firm''s subscription');
  perform public._t_assert((select count(*) from public.usage_ledger) = 0, 'a user cannot read another firm''s usage ledger');
  perform public._t_assert((select count(*) from public.billing_events where firm_id = fa) = 0, 'a user cannot read another firm''s billing events');
  perform public._t_assert(public.billing_overview(fa) is null, 'billing_overview for a foreign firm returns nothing');
  perform public._t_assert(public.billing_overview(fb) -> 'plan' ->> 'code' = 'pilot', 'billing_overview for the own firm works');
end $$;
reset role;

-- a plain member of firm A can read (read-only access to) the firm's billing
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0003","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000c0003', true);
set local role authenticated;
do $$
declare fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
begin
  perform public._t_assert((select count(*) from public.subscriptions where firm_id = fa) = 1, 'a firm member can read the firm''s subscription');
  perform public._t_assert(public.billing_overview(fa) -> 'plan' ->> 'code' = 'pilot', 'a member sees the plan through billing_overview');
end $$;
reset role;

-- ---------------------------------------------------------------- 9. browsers cannot write plans, subscriptions, usage or billing events
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000c0001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000c0001', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  ok boolean;
begin
  perform public._t_assert((select count(*) from public.subscriptions where firm_id = fa) = 1, 'the owner can read their subscription');

  ok := false; begin update public.subscriptions set plan_code = 'ca_firm' where firm_id = fa; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot change the plan in subscriptions');
  ok := false; begin update public.subscriptions set status = 'active', current_period_end = now() + interval '5 years' where firm_id = fa; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot change status or period dates');
  ok := false; begin insert into public.subscriptions (firm_id, plan_code) values (gen_random_uuid(), 'ca_firm'); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot insert a subscription');
  ok := false; begin delete from public.subscriptions where firm_id = fa; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot delete a subscription');
  ok := false; begin update public.plans set price_paise = 0, monthly_invoice_limit = 1000000 where code = 'pilot'; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot edit plans (prices or limits)');
  ok := false; begin insert into public.plans (code, name, price_paise, monthly_invoice_limit, batch_max_files) values ('free_forever', 'Free forever', 0, 999999, 100); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot create plans');
  ok := false; begin insert into public.usage_ledger (firm_id, invoice_id, period_start, period_end, plan_code, state) values (fa, gen_random_uuid(), now(), now() + interval '1 day', 'pilot', 'released'); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot insert usage');
  ok := false; begin update public.usage_ledger set state = 'released' where firm_id = fa; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot release used quota');
  ok := false; begin delete from public.usage_ledger where firm_id = fa; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot delete usage');
  ok := false; begin insert into public.billing_events (firm_id, event) values (fa, 'fake'); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot write billing events');
  ok := false; begin perform public.change_plan(fa, '00000000-0000-4000-8000-0000000c0001', 'ca_firm', true); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot call change_plan directly');
  ok := false; begin perform public.enqueue_metered_jobs(fa, '00000000-0000-4000-8000-0000000c0001', array[gen_random_uuid()], 1000000, 1000000); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot call enqueue_metered_jobs directly');
  ok := false; begin perform public.roll_subscription_period(fa); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot call roll_subscription_period');
  -- a browser can still create a batch within the plan limit, but not above it
  insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-0000000c0001', 5);
  ok := false; begin insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-0000000c0001', 6); exception when check_violation then ok := true; end;
  perform public._t_assert(ok, 'a browser cannot create a batch above the plan limit');
end $$;
reset role;

-- visitors who are not signed in: plans are public, everything else is not
set local role anon;
do $$
declare ok boolean := false;
begin
  perform public._t_assert((select count(*) from public.plans) = 3, 'anon can read the public plans');
  begin perform count(*) from public.subscriptions; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'anon cannot read subscriptions');
end $$;
reset role;

-- ---------------------------------------------------------------- 10. the server (service_role) can call the billing functions
set local role service_role;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-0000000c0001');
  r jsonb;
begin
  r := public.enqueue_metered_jobs(fa, '00000000-0000-4000-8000-0000000c0001', array[]::uuid[], 100, 5);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0, 'service_role can call enqueue_metered_jobs');
  r := public.change_plan(fa, '00000000-0000-4000-8000-0000000c0001', 'solo', true);
  perform public._t_assert(r ->> 'result' = 'upgraded', 'service_role can call change_plan');
end $$;
reset role;

rollback;
select 'PHASE 5 SQL TESTS PASSED' as result;
