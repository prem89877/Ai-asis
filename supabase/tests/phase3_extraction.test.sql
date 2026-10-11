-- AI Asis Phase 3: database tests (plain SQL, no extensions needed).
--
-- HOW TO RUN (use a scratch / local Supabase database, never production data):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase3_extraction.test.sql
--   or paste the whole file into the Supabase SQL Editor and run it once.
--
-- Prerequisite: all five migrations (0001 .. 0003 of Phase 2, then the two Phase 3 files) are applied.
-- Everything runs inside one transaction that is rolled back at the end, so no test data is kept.
-- Result: the last output is a single row "PHASE 3 SQL TESTS PASSED". If any check fails the script stops
-- with "TEST FAILED: <name>" and the row is never shown. If it stops with an error, run:  rollback;
-- psql also prints one "PASS: <name>" notice per check.

begin;

-- ---------------------------------------------------------------- helpers (rolled back with everything else)
create function public._t_assert(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond is not true then
    raise exception 'TEST FAILED: %', msg;
  end if;
  raise notice 'PASS: %', msg;
end $$;

create function public._t_user(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_firm uuid;
begin
  -- The signup trigger creates the profile, a personal firm and the owner membership.
  insert into auth.users (id, email) values (p_id, p_id::text || '@test.invalid');
  select m.firm_id into v_firm from public.firm_members m where m.user_id = p_id;
  return v_firm;
end $$;

create function public._t_firm(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.firm_id from public.firm_members m where m.user_id = p_user limit 1;
$$;

create function public._t_inv(p_id uuid, p_firm uuid, p_status text default 'uploaded') returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values (p_id, p_firm, p_firm::text || '/' || p_id::text || '.pdf', 'test.pdf', 'application/pdf', 1000,
          encode(sha256(convert_to(p_id::text, 'utf8')), 'hex'), p_status::public.invoice_status);
  return p_id;
end $$;

grant execute on function public._t_assert(boolean, text) to anon, authenticated, service_role;
grant execute on function public._t_firm(uuid) to anon, authenticated, service_role;

select public._t_user('00000000-0000-4000-8000-00000000a001'::uuid) as firm_a, public._t_user('00000000-0000-4000-8000-00000000a002'::uuid) as firm_b,
       public._t_user('00000000-0000-4000-8000-00000000a003'::uuid) as firm_c, public._t_user('00000000-0000-4000-8000-00000000a004'::uuid) as firm_d;

-- ---------------------------------------------------------------- 1. schema objects
do $$
begin
  perform public._t_assert(to_regclass('public.batches') is not null, 'batches table exists');
  perform public._t_assert(to_regclass('public.extraction_usage_monthly') is not null, 'usage view exists');
  perform public._t_assert((select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'job_status' and e.enumlabel in ('queued', 'processing', 'needs_review', 'completed', 'failed')) = 5,
    'job_status has Queued, Processing, Needs Review, Completed, Failed');
  perform public._t_assert((select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'invoice_status' and e.enumlabel = 'completed') = 1, 'invoice_status has completed');
  perform public._t_assert((select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'extracted_data' and column_name = 'currency') = 'YES',
    'currency is nullable (never defaulted)');
  perform public._t_assert((select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'extracted_data' and column_name = 'currency') is null,
    'currency has no default');
  perform public._t_assert((select numeric_scale from information_schema.columns
    where table_schema = 'public' and table_name = 'line_items' and column_name = 'unit_price') = 4,
    'unit_price keeps 4 decimals');
  perform public._t_assert((select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'usage_records'
      and column_name in ('job_id', 'model', 'input_tokens', 'output_tokens', 'estimated_cost_usd', 'outcome')) = 6,
    'usage_records has cost columns');
  perform public._t_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('enqueue_extraction_jobs', 'claim_extraction_job', 'complete_extraction_job')) = 3,
    'the three server functions exist');
end $$;

-- ---------------------------------------------------------------- 2. enqueue: happy path, idempotency, eligibility
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006901', fa);
  perform public._t_inv('00000000-0000-4000-8000-000000006902', fa);
  perform public._t_inv('00000000-0000-4000-8000-000000006903', fa);
  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006901', '00000000-0000-4000-8000-000000006902', '00000000-0000-4000-8000-000000006903']::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 3 and jsonb_array_length(r -> 'skipped') = 0, 'enqueue queues 3 uploaded invoices');
  perform public._t_assert((select count(*) from public.processing_jobs where firm_id = fa and status = 'queued') = 3, 'three queued jobs exist');
  perform public._t_assert((select count(*) from public.invoices where firm_id = fa and status = 'queued') = 3, 'invoice status moved to queued');
  perform public._t_assert((select count(*) from public.processing_jobs where firm_id = fa and requested_by = '00000000-0000-4000-8000-00000000a001') = 3, 'jobs record who requested them');

  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006901', '00000000-0000-4000-8000-000000006902']::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0 and r -> 'skipped' -> 0 ->> 'reason' = 'already_queued', 'queueing twice is a no-op (already_queued)');
  perform public._t_assert((select count(*) from public.processing_jobs where firm_id = fa) = 3, 'no duplicate jobs were created');

  perform public._t_inv('00000000-0000-4000-8000-000000006904', fa, 'needs_review');
  perform public._t_inv('00000000-0000-4000-8000-000000006905', fa, 'pending_deletion');
  perform public._t_inv('00000000-0000-4000-8000-000000006906', fa, 'completed');
  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006904', '00000000-0000-4000-8000-000000006905', '00000000-0000-4000-8000-000000006906', '00000000-0000-4000-8000-000000007801']::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0 and jsonb_array_length(r -> 'skipped') = 3, 'finished / deleting invoices are not eligible');
  perform public._t_assert(not exists (select 1 from jsonb_array_elements(r -> 'skipped') e where e ->> 'reason' <> 'not_eligible'), 'reason is not_eligible');
  perform public._t_assert(not exists (select 1 from jsonb_array_elements(r -> 'skipped') e where e ->> 'invoice_id' = '00000000-0000-4000-8000-000000007801'), 'an unknown id is simply absent from the result');

  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array[]::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0, 'empty id list is a no-op');
end $$;

-- ---------------------------------------------------------------- 3. enqueue: another firm cannot be reached
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  fb uuid := public._t_firm('00000000-0000-4000-8000-00000000a002');
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006a01', fb);
  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006a01']::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0 and jsonb_array_length(r -> 'skipped') = 0, 'firm A cannot queue firm B invoices');
  perform public._t_assert((select status from public.invoices where id = '00000000-0000-4000-8000-000000006a01') = 'uploaded', 'firm B invoice untouched');
end $$;

-- ---------------------------------------------------------------- 4. quota and rate limit (firm C)
do $$
declare
  fc uuid := public._t_firm('00000000-0000-4000-8000-00000000a003');
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006301', fc);
  perform public._t_inv('00000000-0000-4000-8000-000000006302', fc);
  perform public._t_inv('00000000-0000-4000-8000-000000006303', fc);
  r := public.enqueue_extraction_jobs(fc, '00000000-0000-4000-8000-00000000a003', array['00000000-0000-4000-8000-000000006301', '00000000-0000-4000-8000-000000006302']::uuid[], 1, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'monthly quota of 1 lets exactly one invoice in');
  perform public._t_assert(r -> 'skipped' -> 0 ->> 'reason' = 'quota_exceeded' and r -> 'skipped' -> 0 ->> 'invoice_id' = '00000000-0000-4000-8000-000000006302', 'the other is skipped with quota_exceeded');
  perform public._t_assert((select status from public.invoices where id = '00000000-0000-4000-8000-000000006302') = 'uploaded', 'quota-skipped invoice stays uploaded');

  r := public.enqueue_extraction_jobs(fc, '00000000-0000-4000-8000-00000000a003', array['00000000-0000-4000-8000-000000006303']::uuid[], 100, 1, 3);
  perform public._t_assert(r -> 'skipped' -> 0 ->> 'reason' = 'rate_limited', 'per-minute limit blocks when the firm just queued a job');
  r := public.enqueue_extraction_jobs(fc, '00000000-0000-4000-8000-00000000a003', array['00000000-0000-4000-8000-000000006303']::uuid[], 100, 2, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'a higher per-minute limit lets it through');
end $$;

-- ---------------------------------------------------------------- 5. runs per invoice
do $$
declare
  fc uuid := public._t_firm('00000000-0000-4000-8000-00000000a003');
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006304', fc, 'failed');
  insert into public.processing_jobs (invoice_id, firm_id, status, error_code) values ('00000000-0000-4000-8000-000000006304', fc, 'failed', 'not_an_invoice');
  r := public.enqueue_extraction_jobs(fc, '00000000-0000-4000-8000-00000000a003', array['00000000-0000-4000-8000-000000006304']::uuid[], 100, 100, 1);
  perform public._t_assert(r -> 'skipped' -> 0 ->> 'reason' = 'max_runs_reached', 'retry limit per invoice is enforced');
  r := public.enqueue_extraction_jobs(fc, '00000000-0000-4000-8000-00000000a003', array['00000000-0000-4000-8000-000000006304']::uuid[], 100, 100, 2);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'a failed invoice can be retried while runs remain');
end $$;

-- ---------------------------------------------------------------- 6. provider trouble does not use quota (firm D)
do $$
declare
  fd uuid := public._t_firm('00000000-0000-4000-8000-00000000a004');
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006401', fd, 'failed');
  perform public._t_inv('00000000-0000-4000-8000-000000006402', fd, 'failed');
  perform public._t_inv('00000000-0000-4000-8000-000000006403', fd, 'failed');
  perform public._t_inv('00000000-0000-4000-8000-000000006404', fd);
  insert into public.processing_jobs (invoice_id, firm_id, status, error_code) values ('00000000-0000-4000-8000-000000006401', fd, 'failed', 'provider_unavailable');
  insert into public.processing_jobs (invoice_id, firm_id, status, error_code) values ('00000000-0000-4000-8000-000000006402', fd, 'failed', 'not_an_invoice');
  insert into public.processing_jobs (invoice_id, firm_id, status, error_code) values ('00000000-0000-4000-8000-000000006403', fd, 'failed', null);
  r := public.enqueue_extraction_jobs(fd, '00000000-0000-4000-8000-00000000a004', array['00000000-0000-4000-8000-000000006404']::uuid[], 2, 100, 3);
  perform public._t_assert(r -> 'skipped' -> 0 ->> 'reason' = 'quota_exceeded', 'user-caused failures count toward the quota (2 used of 2)');
  r := public.enqueue_extraction_jobs(fd, '00000000-0000-4000-8000-00000000a004', array['00000000-0000-4000-8000-000000006404']::uuid[], 3, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'a provider_unavailable failure did not use quota (2 used of 3)');
end $$;

-- ---------------------------------------------------------------- 7. claim
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  fb uuid := public._t_firm('00000000-0000-4000-8000-00000000a002');
  fd uuid := public._t_firm('00000000-0000-4000-8000-00000000a004');
  r jsonb;
begin
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006901', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'claimed' and r ->> 'job_id' is not null, 'queued job is claimed');
  perform public._t_assert(r ->> 'storage_path' = fa::text || '/00000000-0000-4000-8000-000000006901.pdf' and r ->> 'mime_type' = 'application/pdf' and length(r ->> 'sha256') = 64, 'claim returns what the worker needs');
  perform public._t_assert((select status from public.processing_jobs where id = (r ->> 'job_id')::uuid) = 'processing', 'job is processing');
  perform public._t_assert((select started_at is not null from public.processing_jobs where id = (r ->> 'job_id')::uuid), 'started_at is set');
  perform public._t_assert((select status from public.invoices where id = '00000000-0000-4000-8000-000000006901') = 'processing', 'invoice is processing');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006901', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'already_processing', 'a second claim is refused (already_processing)');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006902', fa, 1, 180);
  perform public._t_assert(r ->> 'result' = 'busy', 'per-firm concurrency limit returns busy');
  perform public._t_assert((select status from public.processing_jobs where invoice_id = '00000000-0000-4000-8000-000000006902') = 'queued', 'busy leaves the job queued');
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006902', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'claimed', 'claim works once there is room');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006901', fb, 5, 180);
  perform public._t_assert(r ->> 'result' = 'not_found', 'claim with another firm id finds nothing');
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000007801', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'not_found', 'unknown invoice is not_found');

  perform public._t_inv('00000000-0000-4000-8000-000000006907', fa);
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006907', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'no_job', 'invoice without a job is no_job');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006401', fd, 5, 180);
  perform public._t_assert(r ->> 'result' = 'not_queued', 'invoice whose latest job failed is not_queued');

  perform public._t_inv('00000000-0000-4000-8000-000000006908', fa, 'pending_deletion');
  insert into public.processing_jobs (invoice_id, firm_id, status) values ('00000000-0000-4000-8000-000000006908', fa, 'queued');
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006908', fa, 5, 180);
  perform public._t_assert(r ->> 'result' = 'not_found', 'invoice being deleted cannot be claimed');
end $$;

-- ---------------------------------------------------------------- 8. stale jobs are failed so they can be retried
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  r jsonb;
begin
  update public.processing_jobs set started_at = now() - interval '10 minutes' where firm_id = fa and status = 'processing';
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006903', fa, 1, 180);
  perform public._t_assert(r ->> 'result' = 'claimed', 'claim succeeds after stale jobs are cleared');
  perform public._t_assert((select count(*) from public.processing_jobs where firm_id = fa and status = 'failed' and error_code = 'stale_timeout') = 2, 'both stale jobs failed with stale_timeout');
  perform public._t_assert((select status from public.invoices where id = '00000000-0000-4000-8000-000000006901') = 'failed', 'stale invoice is failed, so it can be retried');
  perform public._t_assert((select status from public.invoices where id = '00000000-0000-4000-8000-000000006903') = 'processing', 'new claim is processing');
end $$;

-- ---------------------------------------------------------------- 9. complete: needs_review with items, genuine zero, precision
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_job uuid := (select id from public.processing_jobs where invoice_id = '00000000-0000-4000-8000-000000006903' and status = 'processing');
  r jsonb;
  v_ex jsonb;
  v_items jsonb;
begin
  v_ex := jsonb_build_object(
    'vendor_name', 'Acme Traders', 'buyer_name', 'Beta Stores', 'vendor_gstin', '27AAPFU0939F1ZV', 'buyer_gstin', null::text,
    'invoice_number', 'INV-001', 'invoice_number_norm', 'INV001', 'invoice_date', '2026-09-15',
    'place_of_supply', 'Maharashtra (27)', 'currency', null::text,
    'taxable_amount', 1000, 'discount_amount', null::numeric, 'cgst_amount', 90, 'sgst_amount', 90,
    'igst_amount', null::numeric, 'cess_amount', 0, 'total_amount', 1180,
    'confidence', 0.953, 'document_type', 'tax_invoice',
    'review_flags', jsonb_build_array(jsonb_build_object('code', 'low_confidence', 'severity', 'warning', 'message', 'x')),
    'field_status', jsonb_build_object('cess_amount', jsonb_build_object('state', 'zero', 'confidence', 0.9)),
    'raw_extraction', jsonb_build_object('document_type', 'tax_invoice'), 'extraction_model', 'test-model');
  v_items := jsonb_build_array(
    jsonb_build_object('description', 'Widget', 'hsn_code', '8471', 'quantity', 2, 'unit', 'Nos', 'unit_price', 500.1234,
      'discount_amount', null::numeric, 'taxable_amount', 1000, 'gst_rate', 0, 'gst_amount', 0, 'line_total', 1000,
      'field_status', jsonb_build_object('gst_rate', jsonb_build_object('state', 'zero', 'confidence', 0.9))),
    jsonb_build_object('description', 'Gadget', 'hsn_code', null::text, 'quantity', 1, 'unit', null::text, 'unit_price', 10,
      'discount_amount', null::numeric, 'taxable_amount', 10, 'gst_rate', null::numeric, 'gst_amount', null::numeric, 'line_total', null::numeric,
      'field_status', '{}'::jsonb));

  r := public.complete_extraction_job(v_job, fa, 'needs_review', v_ex, v_items, 2, null);
  perform public._t_assert(r ->> 'result' = 'ok', 'complete returns ok');
  perform public._t_assert((select count(*) from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903') = 1, 'one extracted_data row saved');
  perform public._t_assert((select vendor_gstin = '27AAPFU0939F1ZV' and invoice_date = date '2026-09-15' and total_amount = 1180 and invoice_number_norm = 'INV001'
    from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903'), 'header values saved as given');
  perform public._t_assert((select cess_amount is not null and cess_amount = 0 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903'), 'genuine zero is stored as 0, not NULL');
  perform public._t_assert((select igst_amount is null and buyer_gstin is null and currency is null and discount_amount is null from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903'), 'missing values stay NULL (currency is not defaulted)');
  perform public._t_assert((select field_status -> 'cess_amount' ->> 'state' = 'zero' and jsonb_array_length(review_flags) = 1 and extraction_model = 'test-model' and extracted_at is not null and verified_at is null
    from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903'), 'field status, flags and model are saved; not verified');
  perform public._t_assert((select count(*) from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903') = 2, 'two line items saved');
  perform public._t_assert((select array_agg("position" order by "position") from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903') = array[1, 2], 'positions are 1 and 2');
  perform public._t_assert((select unit_price = 500.1234 and gst_rate is not null and gst_rate = 0 from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903' and "position" = 1), 'unit price keeps 4 decimals; zero GST rate kept');
  perform public._t_assert((select hsn_code is null and unit is null and gst_rate is null from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903' and "position" = 2), 'missing item values stay NULL');
  perform public._t_assert((select status = 'needs_review' and attempts = 2 and error_code is null and finished_at is not null from public.processing_jobs where id = v_job), 'job closed as needs_review');
  perform public._t_assert((select status = 'needs_review' from public.invoices where id = '00000000-0000-4000-8000-000000006903'), 'invoice is needs_review');

  r := public.complete_extraction_job(v_job, fa, 'failed', null, null, 5, 'internal_error');
  perform public._t_assert(r ->> 'result' = 'not_processing', 'a finished job cannot be completed again');
  perform public._t_assert((select count(*) from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903') = 2 and (select status from public.invoices where id = '00000000-0000-4000-8000-000000006903') = 'needs_review', 'second complete changed nothing');
  r := public.complete_extraction_job(gen_random_uuid(), fa, 'failed', null, null, 1, 'internal_error');
  perform public._t_assert(r ->> 'result' = 'not_found', 'unknown job is not_found');
end $$;

-- ---------------------------------------------------------------- 10. complete: completed and failed paths
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_job uuid;
  r jsonb;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006b01', fa);
  perform public._t_inv('00000000-0000-4000-8000-000000006b02', fa);
  perform public._t_inv('00000000-0000-4000-8000-000000006b03', fa);
  perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006b01', '00000000-0000-4000-8000-000000006b02', '00000000-0000-4000-8000-000000006b03']::uuid[], 100, 100, 3);

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006b01', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;
  r := public.complete_extraction_job(v_job, fa, 'completed',
    jsonb_build_object('vendor_name', 'A', 'review_flags', '[]'::jsonb, 'field_status', '{}'::jsonb, 'document_type', 'tax_invoice'), '[]'::jsonb, 1, null);
  perform public._t_assert(r ->> 'result' = 'ok' and (select status from public.invoices where id = '00000000-0000-4000-8000-000000006b01') = 'completed', 'completed outcome sets invoice completed');
  perform public._t_assert((select status = 'completed' from public.processing_jobs where id = v_job), 'job is completed');
  perform public._t_assert((select count(*) from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006b01') = 0, 'no items is fine');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006b02', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;
  r := public.complete_extraction_job(v_job, fa, 'failed', null, null, 3, 'provider_timeout');
  perform public._t_assert(r ->> 'result' = 'ok', 'failed outcome is accepted');
  perform public._t_assert((select status = 'failed' and error_code = 'provider_timeout' and attempts = 3 and finished_at is not null from public.processing_jobs where id = v_job), 'job failed with its error code');
  perform public._t_assert((select status = 'failed' from public.invoices where id = '00000000-0000-4000-8000-000000006b02') and not exists (select 1 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006b02'), 'failed invoice has no extracted data');

  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006b03', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;
  perform public.complete_extraction_job(v_job, fa, 'failed', null, null, 1, null);
  perform public._t_assert((select error_code = 'internal_error' from public.processing_jobs where id = v_job), 'missing error code becomes internal_error');
end $$;

-- ---------------------------------------------------------------- 11. re-run replaces results and clears verification
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_job uuid;
  r jsonb;
begin
  update public.extracted_data set verified_by = '00000000-0000-4000-8000-00000000a001', verified_at = now() where invoice_id = '00000000-0000-4000-8000-000000006903';
  update public.invoices set status = 'failed' where id = '00000000-0000-4000-8000-000000006903';
  r := public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006903']::uuid[], 100, 100, 3);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 1, 'failed invoice can be queued again');
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006903', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;
  r := public.complete_extraction_job(v_job, fa, 'completed',
    jsonb_build_object('vendor_name', 'Acme Traders v2', 'review_flags', '[]'::jsonb, 'field_status', '{}'::jsonb, 'document_type', 'tax_invoice'),
    jsonb_build_array(jsonb_build_object('description', 'Only item', 'field_status', '{}'::jsonb)), 1, null);
  perform public._t_assert(r ->> 'result' = 'ok', 're-run completes');
  perform public._t_assert((select count(*) from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903') = 1, 'old line items were replaced, not appended');
  perform public._t_assert((select vendor_name = 'Acme Traders v2' and verified_by is null and verified_at is null from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903'), 'new data saved and old verification cleared');
  perform public._t_assert((select count(*) from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903') = 1, 'still one extracted_data row');
  perform public._t_assert((select count(*) from public.processing_jobs where invoice_id = '00000000-0000-4000-8000-000000006903') = 2, 'job history is kept (2 runs)');
end $$;

-- ---------------------------------------------------------------- 12. a bad payload rolls everything back
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_job uuid;
  r jsonb;
  v_raised boolean;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006b04', fa);
  perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006b04']::uuid[], 100, 100, 3);
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006b04', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;

  v_raised := false;
  begin
    perform public.complete_extraction_job(v_job, fa, 'completed',
      jsonb_build_object('vendor_name', 'A', 'total_amount', 'abc', 'review_flags', '[]'::jsonb), '[]'::jsonb, 1, null);
  exception when others then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'non-numeric amount is rejected');
  perform public._t_assert((select status = 'processing' from public.processing_jobs where id = v_job) and not exists (select 1 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006b04'), 'rejected payload left nothing behind');

  v_raised := false;
  begin
    perform public.complete_extraction_job(v_job, fa, 'completed',
      jsonb_build_object('vendor_name', 'A', 'review_flags', '[]'::jsonb),
      jsonb_build_array(jsonb_build_object('description', 'x', 'hsn_code', '12')), 1, null);
  exception when check_violation then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'invalid HSN violates the table check');
  perform public._t_assert(not exists (select 1 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006b04') and (select status = 'processing' from public.invoices where id = '00000000-0000-4000-8000-000000006b04'),
    'header data was rolled back together with the failed items (atomic)');

  v_raised := false;
  begin
    perform public.complete_extraction_job(v_job, fa, 'completed', null, '[]'::jsonb, 1, null);
  exception when others then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'completed without a payload is rejected');

  v_raised := false;
  begin
    perform public.complete_extraction_job(v_job, fa, 'bogus', null, null, 1, null);
  exception when invalid_parameter_value then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'unknown outcome is rejected');

  v_raised := false;
  begin
    perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006b04']::uuid[], -1, 10, 3);
  exception when invalid_parameter_value then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'negative limits are rejected');

  r := public.complete_extraction_job(v_job, fa, 'failed', null, null, 1, 'internal_error');
  perform public._t_assert(r ->> 'result' = 'ok', 'the job can still be closed afterwards');
end $$;

-- ---------------------------------------------------------------- 13. invoice deleted while processing / one active job per invoice
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_job uuid;
  r jsonb;
  v_raised boolean := false;
begin
  perform public._t_inv('00000000-0000-4000-8000-000000006b05', fa);
  perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006b05']::uuid[], 100, 100, 3);
  r := public.claim_extraction_job('00000000-0000-4000-8000-000000006b05', fa, 10, 180);
  v_job := (r ->> 'job_id')::uuid;
  update public.invoices set status = 'pending_deletion' where id = '00000000-0000-4000-8000-000000006b05';
  r := public.complete_extraction_job(v_job, fa, 'completed', jsonb_build_object('vendor_name', 'A', 'review_flags', '[]'::jsonb), '[]'::jsonb, 1, null);
  perform public._t_assert(r ->> 'result' = 'invoice_removed', 'result is invoice_removed');
  perform public._t_assert((select status = 'failed' and error_code = 'invoice_removed' from public.processing_jobs where id = v_job), 'job is closed as invoice_removed');
  perform public._t_assert(not exists (select 1 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006b05'), 'no data saved for a deleted invoice');

  perform public._t_inv('00000000-0000-4000-8000-000000006b06', fa);
  perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006b06']::uuid[], 100, 100, 3);
  begin
    insert into public.processing_jobs (invoice_id, firm_id, status) values ('00000000-0000-4000-8000-000000006b06', fa, 'queued');
  exception when unique_violation then
    v_raised := true;
  end;
  perform public._t_assert(v_raised, 'a second active job for the same invoice is impossible');
end $$;

-- ---------------------------------------------------------------- 14. only the server may call the functions
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_denied boolean;
begin
  v_denied := false;
  begin
    perform public.enqueue_extraction_jobs(fa, '00000000-0000-4000-8000-00000000a001', array['00000000-0000-4000-8000-000000006901']::uuid[], 100, 100, 3);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'signed-in users cannot call enqueue_extraction_jobs');

  v_denied := false;
  begin
    perform public.claim_extraction_job('00000000-0000-4000-8000-000000006901', fa, 10, 180);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'signed-in users cannot call claim_extraction_job');

  v_denied := false;
  begin
    perform public.complete_extraction_job(gen_random_uuid(), fa, 'completed', '{}'::jsonb, '[]'::jsonb, 1, null);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'signed-in users cannot forge results with complete_extraction_job');
end $$;
reset role;

set local role anon;
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.enqueue_extraction_jobs(gen_random_uuid(), gen_random_uuid(), array[]::uuid[], 1, 1, 1);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'anonymous users cannot call enqueue_extraction_jobs');
end $$;
reset role;

set local role service_role;
do $$
declare r jsonb;
begin
  r := public.enqueue_extraction_jobs(public._t_firm('00000000-0000-4000-8000-00000000a001'), '00000000-0000-4000-8000-00000000a001', array[]::uuid[], 1, 1, 1);
  perform public._t_assert(jsonb_array_length(r -> 'enqueued') = 0, 'service_role can call the functions');
end $$;
reset role;

-- ---------------------------------------------------------------- 15. row level security: reads yes, writes no, isolation between firms
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_denied boolean;
begin
  perform public._t_assert((select count(*) from public.extracted_data) >= 1 and not exists (select 1 from public.extracted_data where firm_id <> fa), 'user A reads only firm A extracted data');
  perform public._t_assert((select count(*) from public.line_items) >= 1 and not exists (select 1 from public.line_items where firm_id <> fa), 'user A reads only firm A line items');
  perform public._t_assert((select count(*) from public.processing_jobs) >= 1 and not exists (select 1 from public.processing_jobs where firm_id <> fa), 'user A reads only firm A jobs');

  v_denied := false;
  begin
    insert into public.extracted_data (invoice_id, firm_id, vendor_name) values ('00000000-0000-4000-8000-000000006901', fa, 'forged');
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot insert extracted_data');

  v_denied := false;
  begin
    update public.extracted_data set vendor_name = 'forged' where invoice_id = '00000000-0000-4000-8000-000000006903';
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot edit extracted_data');

  v_denied := false;
  begin
    delete from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903';
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot delete extracted_data');

  v_denied := false;
  begin
    update public.line_items set description = 'forged' where invoice_id = '00000000-0000-4000-8000-000000006903';
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot edit line_items');

  v_denied := false;
  begin
    insert into public.line_items (invoice_id, firm_id, "position") values ('00000000-0000-4000-8000-000000006903', fa, 99);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot insert line_items');

  v_denied := false;
  begin
    update public.processing_jobs set status = 'completed' where firm_id = fa;
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot edit jobs');

  v_denied := false;
  begin
    insert into public.usage_records (firm_id, kind) values (fa, 'extraction');
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'users cannot write usage records');
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a002', true);
set local role authenticated;
do $$
begin
  perform public._t_assert((select count(*) from public.extracted_data) = 0, 'user B sees no firm A extracted data');
  perform public._t_assert((select count(*) from public.line_items) = 0, 'user B sees no firm A line items');
  perform public._t_assert((select count(*) from public.processing_jobs) = 0, 'user B sees no firm A jobs');
  perform public._t_assert((select count(*) from public.usage_records) = 0, 'user B sees no firm A usage');
  perform public._t_assert((select count(*) from public.invoices where id in ('00000000-0000-4000-8000-000000006901', '00000000-0000-4000-8000-000000006903')) = 0, 'user B sees no firm A invoices');
end $$;
reset role;

-- ---------------------------------------------------------------- 16. invoice status is server-managed
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);
set local role authenticated;
do $$
declare v_denied boolean;
begin
  v_denied := false;
  begin
    update public.invoices set status = 'verified' where id = '00000000-0000-4000-8000-000000006903';
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'a user cannot mark an invoice verified');

  v_denied := false;
  begin
    update public.invoices set status = 'completed' where id = '00000000-0000-4000-8000-000000006902';
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'a user cannot mark an invoice completed');

  update public.invoices set original_filename = 'renamed.pdf' where id = '00000000-0000-4000-8000-000000006903';
  perform public._t_assert(found, 'a user can still rename an invoice');

  update public.invoices set status = 'pending_deletion', deletion_requested_at = now() where id = '00000000-0000-4000-8000-000000006902';
  perform public._t_assert(found, 'the delete workflow can still set pending_deletion');
end $$;
reset role;

-- ---------------------------------------------------------------- 17. batches: capacity, isolation, spoofing
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  fb uuid := public._t_firm('00000000-0000-4000-8000-00000000a002');
  v_batch uuid;
  v_denied boolean;
begin
  insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-00000000a001', 2) returning id into v_batch;
  perform public._t_assert(v_batch is not null, 'user can create a batch for their own firm');

  insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256, status, batch_id)
  values ('00000000-0000-4000-8000-000000006c01', fa, '00000000-0000-4000-8000-00000000a001', fa::text || '/00000000-0000-4000-8000-000000006c01.pdf', 'a.pdf', 'application/pdf', 10, repeat('a', 64), 'uploaded', v_batch);
  insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256, status, batch_id)
  values ('00000000-0000-4000-8000-000000006c02', fa, '00000000-0000-4000-8000-00000000a001', fa::text || '/00000000-0000-4000-8000-000000006c02.pdf', 'b.pdf', 'application/pdf', 10, repeat('b', 64), 'uploaded', v_batch);
  perform public._t_assert((select count(*) from public.invoices where batch_id = v_batch) = 2, 'a batch of 2 accepts 2 files');

  v_denied := false;
  begin
    insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256, status, batch_id)
    values ('00000000-0000-4000-8000-000000006c03', fa, '00000000-0000-4000-8000-00000000a001', fa::text || '/00000000-0000-4000-8000-000000006c03.pdf', 'c.pdf', 'application/pdf', 10, repeat('c', 64), 'uploaded', v_batch);
  exception when check_violation then
    v_denied := sqlerrm like '%batch_full%';
  end;
  perform public._t_assert(v_denied, 'the third file is refused with batch_full');

  v_denied := false;
  begin
    insert into public.batches (firm_id, created_by, file_count) values (fb, '00000000-0000-4000-8000-00000000a001', 1);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'a user cannot create a batch in another firm');

  v_denied := false;
  begin
    insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-00000000a002', 1);
  exception when insufficient_privilege then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'a user cannot create a batch in someone else''s name');

  v_denied := false;
  begin
    insert into public.batches (firm_id, created_by, file_count) values (fa, '00000000-0000-4000-8000-00000000a001', 101);
  exception when check_violation then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'batch size above 100 is refused by the database');

  perform set_config('t.batch', v_batch::text, true);
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a002', true);
set local role authenticated;
do $$
declare
  fb uuid := public._t_firm('00000000-0000-4000-8000-00000000a002');
  v_denied boolean := false;
begin
  perform public._t_assert((select count(*) from public.batches) = 0, 'user B cannot see firm A batches');
  begin
    insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256, status, batch_id)
    values ('00000000-0000-4000-8000-000000006c04', fb, '00000000-0000-4000-8000-00000000a002', fb::text || '/00000000-0000-4000-8000-000000006c04.pdf', 'd.pdf', 'application/pdf', 10, repeat('d', 64), 'uploaded', current_setting('t.batch')::uuid);
  exception when foreign_key_violation then
    v_denied := true;
  end;
  perform public._t_assert(v_denied, 'an invoice cannot be attached to another firm''s batch');
end $$;
reset role;

do $$
declare v_batch uuid := current_setting('t.batch')::uuid;
begin
  delete from public.batches where id = v_batch;
  perform public._t_assert((select count(*) from public.invoices where id in ('00000000-0000-4000-8000-000000006c01', '00000000-0000-4000-8000-000000006c02')) = 2, 'deleting a batch keeps its invoices');
  perform public._t_assert((select count(*) from public.invoices where id in ('00000000-0000-4000-8000-000000006c01', '00000000-0000-4000-8000-000000006c02') and batch_id is null) = 2, 'their batch_id is cleared');
end $$;

-- ---------------------------------------------------------------- 18. usage and cost tracking
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v_denied boolean := false;
begin
  insert into public.usage_records (firm_id, user_id, kind, quantity, invoice_id, model, input_tokens, output_tokens, estimated_cost_usd, outcome)
  values (fa, '00000000-0000-4000-8000-00000000a001', 'extraction', 1, '00000000-0000-4000-8000-000000006901', 'test-model', 1000, 400, 0.0013, 'ok'),
         (fa, '00000000-0000-4000-8000-00000000a001', 'extraction', 1, '00000000-0000-4000-8000-000000006901', 'test-model', 2000, 100, 0.00085, 'invalid_model_output'),
         (fa, '00000000-0000-4000-8000-00000000a001', 'invoice_upload', 1, '00000000-0000-4000-8000-000000006901', null, null, null, null, null);
  begin
    insert into public.usage_records (firm_id, kind, estimated_cost_usd) values (fa, 'extraction', -1);
  exception when check_violation then v_denied := true;
  end;
  perform public._t_assert(v_denied, 'negative cost is refused');
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);
set local role authenticated;
do $$
declare
  fa uuid := public._t_firm('00000000-0000-4000-8000-00000000a001');
  v record;
begin
  select * into v from public.extraction_usage_monthly where firm_id = fa;
  perform public._t_assert(v.api_calls = 2 and v.invoices = 1, 'view counts extraction calls only, per distinct invoice');
  perform public._t_assert(v.input_tokens = 3000 and v.output_tokens = 500, 'view sums tokens');
  perform public._t_assert(v.estimated_cost_usd = 0.00215, 'view sums approximate cost');
  perform public._t_assert(v.month = date_trunc('month', now() at time zone 'utc')::date, 'view groups by UTC month');
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a002', true);
set local role authenticated;
do $$
begin
  perform public._t_assert((select count(*) from public.extraction_usage_monthly) = 0, 'user B cannot see firm A usage through the view');
end $$;
reset role;

-- ---------------------------------------------------------------- 19. deleting an invoice removes its extraction data
do $$
begin
  delete from public.invoices where id = '00000000-0000-4000-8000-000000006903';
  perform public._t_assert(not exists (select 1 from public.extracted_data where invoice_id = '00000000-0000-4000-8000-000000006903')
    and not exists (select 1 from public.line_items where invoice_id = '00000000-0000-4000-8000-000000006903')
    and not exists (select 1 from public.processing_jobs where invoice_id = '00000000-0000-4000-8000-000000006903'), 'invoice delete cascades to extracted data, items and jobs');
  perform public._t_assert((select count(*) from public.usage_records where invoice_id = '00000000-0000-4000-8000-000000006901') = 3, 'usage records survive (billing history)');
end $$;

rollback;
select 'PHASE 3 SQL TESTS PASSED' as result;
