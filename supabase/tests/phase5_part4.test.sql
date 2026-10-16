-- AI Asis Phase 5 (Part 4): free-failure classification, worker helpers, upload slots (migration 018). Plain SQL, one transaction, rolled back.
-- HOW TO RUN (scratch / local database only):  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_part4.test.sql
-- Prerequisite: migrations up to 018_quota_worker_upload_cap.sql are applied.
-- STATUS: written, NOT executed (no PostgreSQL in the build environment). Expect small fixes on the first run.
begin;

create function public._t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;

-- 1. classification: an AI call may have been billed, so these consume the unit; provider-side failures and a removed invoice do not
do $$
begin
  perform public._t_assert(not public.is_free_failure('stale_timeout'), 'stale_timeout is NOT free (the Gemini call may have been billed)');
  perform public._t_assert(not public.is_free_failure('internal_error'), 'internal_error is NOT free');
  perform public._t_assert(not public.is_free_failure('invalid_model_output'), 'invalid_model_output is not free');
  perform public._t_assert(public.is_free_failure('provider_unavailable') and public.is_free_failure('provider_rate_limited') and public.is_free_failure('provider_timeout'), 'provider failures stay free');
  perform public._t_assert(public.is_free_failure('invoice_removed'), 'a removed invoice stays free');
  perform public._t_assert(not public.is_free_failure(null), 'no error code is not free');
end $$;

-- 2. a stale job (reaped by the worker, no new claim needed) consumes its quota unit; other firms are reaped too
do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000e0001';
  ub uuid := '00000000-0000-4000-8000-0000000e0002';
  fa uuid; fb uuid;
  ia uuid := '00000000-0000-4000-8000-0000000e1001';
  ib uuid := '00000000-0000-4000-8000-0000000e1002';
  n int;
begin
  insert into auth.users (id, email) values (ua, 'wa@test.invalid'), (ub, 'wb@test.invalid');
  select m.firm_id into fa from public.firm_members m where m.user_id = ua limit 1;
  select m.firm_id into fb from public.firm_members m where m.user_id = ub limit 1;
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values (ia, fa, fa || '/' || ia || '.pdf', 't.pdf', 'application/pdf', 1000, encode(sha256(convert_to(ia::text, 'utf8')), 'hex'), 'uploaded'),
         (ib, fb, fb || '/' || ib || '.pdf', 't.pdf', 'application/pdf', 1000, encode(sha256(convert_to(ib::text, 'utf8')), 'hex'), 'uploaded');
  perform public.enqueue_metered_jobs(fa, ua, array[ia], 100, 5);
  perform public.enqueue_metered_jobs(fb, ub, array[ib], 100, 5);
  -- both jobs are 'processing' since long ago (crashed functions)
  update public.processing_jobs set status = 'processing', started_at = now() - interval '1 hour' where invoice_id in (ia, ib);
  update public.invoices set status = 'processing' where id in (ia, ib);
  n := public.reap_stale_extraction_jobs(240);
  perform public._t_assert(n = 2, 'the worker fails stale jobs of every firm in one call');
  perform public._t_assert((select count(*) from public.processing_jobs where invoice_id in (ia, ib) and status = 'failed' and error_code = 'stale_timeout') = 2, 'both jobs failed with stale_timeout');
  perform public._t_assert((select count(*) from public.invoices where id in (ia, ib) and status = 'failed') = 2, 'both invoices are failed, so they can be retried');
  perform public._t_assert((select count(*) from public.usage_ledger where invoice_id in (ia, ib) and state = 'consumed') = 2, 'a stale job consumes its unit (it was not released)');
  perform public._t_assert(public.reap_stale_extraction_jobs(240) = 0, 'nothing left to reap the second time');
end $$;

-- 3. queued jobs for the worker: oldest first, fair between firms, a just-queued job is left to its browser
do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000e0003';
  fa uuid;
  i1 uuid := '00000000-0000-4000-8000-0000000e1011';
  i2 uuid := '00000000-0000-4000-8000-0000000e1012';
begin
  insert into auth.users (id, email) values (ua, 'wc@test.invalid');
  select m.firm_id into fa from public.firm_members m where m.user_id = ua limit 1;
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values (i1, fa, fa || '/' || i1 || '.pdf', 't.pdf', 'application/pdf', 1000, encode(sha256(convert_to(i1::text, 'utf8')), 'hex'), 'uploaded'),
         (i2, fa, fa || '/' || i2 || '.pdf', 't.pdf', 'application/pdf', 1000, encode(sha256(convert_to(i2::text, 'utf8')), 'hex'), 'uploaded');
  perform public.enqueue_metered_jobs(fa, ua, array[i1, i2], 100, 5);
  perform public._t_assert((select count(*) from public.list_queued_extraction_jobs(10, 3600)) = 0, 'jobs younger than the minimum age are left to the browser');
  perform public._t_assert((select count(*) from public.list_queued_extraction_jobs(10, 0) where firm_id = fa) = 2, 'queued jobs are listed for the worker');
  perform public._t_assert((select count(*) from public.list_queued_extraction_jobs(1, 0)) = 1, 'the limit is respected');
end $$;

-- 4. upload slots: the cap holds, deleting invoices does not give a slot back, a failed upload does
do $$
declare
  ua uuid := '00000000-0000-4000-8000-0000000e0004';
  fa uuid;
  r jsonb;
  inv uuid := '00000000-0000-4000-8000-0000000e1021';
  slot uuid;
begin
  insert into auth.users (id, email) values (ua, 'wd@test.invalid');
  select m.firm_id into fa from public.firm_members m where m.user_id = ua limit 1;

  r := public.reserve_upload_slot(fa, ua, gen_random_uuid(), 2);
  perform public._t_assert(r ->> 'result' = 'ok', 'first slot');
  r := public.reserve_upload_slot(fa, ua, inv, 2);
  perform public._t_assert(r ->> 'result' = 'ok', 'second slot');
  slot := (r ->> 'id')::uuid;
  r := public.reserve_upload_slot(fa, ua, gen_random_uuid(), 2);
  perform public._t_assert(r ->> 'result' = 'limit' and (r ->> 'used')::int = 2, 'third slot is refused at the cap');

  -- the second upload succeeds (an invoice row exists), is then deleted: its slot must NOT come back
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values (inv, fa, fa || '/' || inv || '.pdf', 't.pdf', 'application/pdf', 1000, encode(sha256(convert_to(inv::text, 'utf8')), 'hex'), 'uploaded');
  perform public.release_upload_slot(fa, slot);
  perform public._t_assert((select count(*) from public.upload_events where firm_id = fa) = 2, 'an existing invoice keeps its slot');
  delete from public.invoices where id = inv;
  perform public._t_assert(public.reserve_upload_slot(fa, ua, gen_random_uuid(), 2) ->> 'result' = 'limit', 'deleting the invoice does not lower the count');

  -- a failed upload (no invoice ever existed) gives its slot back
  slot := (select id from public.upload_events where firm_id = fa and invoice_id <> inv limit 1);
  perform public.release_upload_slot(fa, slot);
  perform public._t_assert(public.reserve_upload_slot(fa, ua, gen_random_uuid(), 2) ->> 'result' = 'ok', 'a failed upload frees its slot');

  -- slots older than 24 hours no longer count
  update public.upload_events set created_at = now() - interval '25 hours' where firm_id = fa;
  perform public._t_assert(public.reserve_upload_slot(fa, ua, gen_random_uuid(), 2) ->> 'result' = 'ok', 'slots older than 24 hours do not count');
end $$;

-- 5. nobody but the server may call the worker / slot functions, or read the slot table
set local role authenticated;
do $$
declare ok boolean;
begin
  ok := false; begin perform public.reap_stale_extraction_jobs(1); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'a signed-in user cannot call reap_stale_extraction_jobs');
  ok := false; begin perform public.reserve_upload_slot(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1000000); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'a signed-in user cannot reserve slots with a limit of their own choice');
  ok := false; begin perform public.release_upload_slot(gen_random_uuid(), gen_random_uuid()); exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'a signed-in user cannot release slots');
  ok := false; begin perform count(*) from public.upload_events; exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'upload_events is not readable by users');
end $$;
reset role;

rollback;
select 'PHASE 5 PART 4 SQL TESTS PASSED' as result;
