-- AI Asis Phase 4: database tests for review, verification, export history and preferences (plain SQL).
--
-- HOW TO RUN (scratch / local Supabase database only):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase4_review_export.test.sql
-- Prerequisite: all six migrations applied. Everything runs in one transaction that is rolled back.
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
  insert into auth.users (id, email) values (p_id, p_id::text || '@test.invalid');
  select m.firm_id into v_firm from public.firm_members m where m.user_id = p_id;
  return v_firm;
end $$;
grant execute on function public._t_assert(boolean, text) to anon, authenticated, service_role;

select public._t_user('00000000-0000-4000-8000-00000000b001'::uuid) as firm_a, public._t_user('00000000-0000-4000-8000-00000000b002'::uuid) as firm_b;

-- fixtures (as the table owner): one verified-able invoice per firm
do $$
declare
  fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001');
  fb uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b002');
begin
  insert into public.invoices (id, firm_id, storage_path, original_filename, mime_type, size_bytes, sha256, status)
  values ('00000000-0000-4000-8000-0000000b0a01', fa, fa::text || '/a1.pdf', 'a1.pdf', 'application/pdf', 1000, repeat('a', 64), 'needs_review'),
         ('00000000-0000-4000-8000-0000000b0b01', fb, fb::text || '/b1.pdf', 'b1.pdf', 'application/pdf', 1000, repeat('b', 64), 'needs_review');
  insert into public.extracted_data (invoice_id, firm_id, vendor_name, invoice_number, taxable_amount, total_amount, review_flags)
  values ('00000000-0000-4000-8000-0000000b0a01', fa, 'Acme', 'INV-1', 1000, 1180, '[{"code":"possible_duplicate","severity":"warning","message":"x"},{"code":"missing_field","severity":"warning","field":"supplier_gstin","message":"y"}]'),
         ('00000000-0000-4000-8000-0000000b0b01', fb, 'Other', 'X-1', 5, 5, '[]');
  insert into public.line_items (invoice_id, firm_id, position, description) values ('00000000-0000-4000-8000-0000000b0a01', fa, 1, 'Widget');
end $$;

-- 1. view: flag keys, counts, tenant isolation
do $$ begin
  perform public._t_assert((select flag_count from public.invoice_review_list where id = '00000000-0000-4000-8000-0000000b0a01') = 2, 'view counts flags');
  perform public._t_assert((select flag_keys @> array['possible_duplicate', 'missing_field', 'missing_field:supplier_gstin'] from public.invoice_review_list where id = '00000000-0000-4000-8000-0000000b0a01'), 'view exposes code and code:field keys');
end $$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000b001', true);
set local role authenticated;
do $$
declare fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001'); s jsonb;
begin
  perform public._t_assert((select count(*) from public.invoice_review_list) = 1, 'a member sees only their own firm in the review list');
  perform public._t_assert((select count(*) from public.invoice_review_list where id = '00000000-0000-4000-8000-0000000b0b01') = 0, 'a foreign invoice is invisible through the view');
  s := public.review_summary(fa);
  perform public._t_assert((s ->> 'needs_review')::int = 1 and (s ->> 'verified')::int = 0, 'summary counts own invoices');
  s := public.review_summary((select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b002'));
  perform public._t_assert((s ->> 'total')::int = 0, 'summary for a foreign firm id counts nothing');
end $$;

-- 2. browsers cannot call the server functions or write review data / history
do $$
declare ok boolean := false; fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001');
begin
  begin
    perform public.save_invoice_review(fa, '00000000-0000-4000-8000-0000000b0a01', '00000000-0000-4000-8000-00000000b001', now()::text, 'verify', '{}', '{}', '{}', null, '[]', 'completed', '{}', '[]');
  exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot call save_invoice_review');
  ok := false;
  begin
    insert into public.export_history (firm_id, requested_by, format, invoice_count) values (fa, '00000000-0000-4000-8000-00000000b001', 'csv', 1);
  exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot insert export history');
  ok := false;
  begin
    update public.extracted_data set vendor_name = 'Hacked' where invoice_id = '00000000-0000-4000-8000-0000000b0a01';
  exception when insufficient_privilege then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot update extracted data directly');
  ok := false;
  begin
    update public.invoices set status = 'verified' where id = '00000000-0000-4000-8000-0000000b0a01';
  exception when others then ok := true; end;
  perform public._t_assert(ok, 'authenticated cannot set an invoice to verified');
end $$;

-- 3. export preferences: own row only
do $$
declare fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001'); ok boolean := false;
begin
  insert into public.export_preferences (firm_id, user_id, columns) values (fa, '00000000-0000-4000-8000-00000000b001', array['invoice_number']);
  perform public._t_assert((select count(*) from public.export_preferences) = 1, 'a user can save their own preferences');
  begin
    insert into public.export_preferences (firm_id, user_id, columns) values (fa, '00000000-0000-4000-8000-00000000b002', array['x']);
  exception when others then ok := true; end;
  perform public._t_assert(ok, 'a user cannot write preferences for someone else');
end $$;
reset role;

-- 4. save_invoice_review as the server
set local role service_role;
do $$
declare
  fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001');
  fb uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b002');
  inv uuid := '00000000-0000-4000-8000-0000000b0a01';
  usr uuid := '00000000-0000-4000-8000-00000000b001';
  ts text; r jsonb;
  hdr jsonb := '{"vendor_name":"Acme Traders","invoice_number":"INV-1","invoice_number_norm":"INV1","vendor_gstin":"27AAPFU0939F1ZV","taxable_amount":1000,"total_amount":1180,"document_type":"tax_invoice"}';
begin
  select updated_at::text into ts from public.extracted_data where invoice_id = inv;

  r := public.save_invoice_review(fb, inv, usr, ts, 'save', hdr, '{}', '{}', null, '[]', 'completed', '{}', '[]');
  perform public._t_assert(r ->> 'result' = 'not_found', 'another firm id cannot touch this invoice');

  r := public.save_invoice_review(fa, inv, usr, '2000-01-01T00:00:00+00:00', 'save', hdr, '{}', '{}', null, '[]', 'completed', '{}', '[]');
  perform public._t_assert(r ->> 'result' = 'conflict', 'a stale timestamp is a conflict');
  perform public._t_assert((select vendor_name from public.extracted_data where invoice_id = inv) = 'Acme', 'a conflict writes nothing');

  r := public.save_invoice_review(fa, inv, usr, ts, 'save', hdr, '{"supplier_name":{"state":"value","confidence":1}}', '{"vendor_name":{"original":"Acme","by":"x","at":"y"}}',
    '[{"description":"Gadget","quantity":2,"field_status":{}}]', '[]', 'completed', '{"header":{"vendor_name":{"from":"Acme","to":"Acme Traders"}}}', '[]');
  perform public._t_assert(r ->> 'result' = 'ok' and r ->> 'status' = 'completed', 'save succeeds and sets the status passed in');
  perform public._t_assert((select vendor_name from public.extracted_data where invoice_id = inv) = 'Acme Traders', 'header values were saved');
  perform public._t_assert((select items_edited and edited_by = usr and verified_at is null from public.extracted_data where invoice_id = inv), 'edit is recorded, not verified');
  perform public._t_assert((select description from public.line_items where invoice_id = inv and position = 1) = 'Gadget', 'items were replaced');
  perform public._t_assert((select count(*) from public.review_events where invoice_id = inv and action = 'edit') = 1, 'an edit event was written');

  select updated_at::text into ts from public.extracted_data where invoice_id = inv;
  r := public.save_invoice_review(fa, inv, usr, ts, 'verify', hdr, '{}', '{}', null, '[]', 'completed', '{}', '[{"code":"possible_duplicate"}]');
  perform public._t_assert(r ->> 'status' = 'verified' and (select status from public.invoices where id = inv) = 'verified', 'verify sets invoice status verified');
  perform public._t_assert((select verified_by = usr and verified_at is not null from public.extracted_data where invoice_id = inv), 'verifier and time recorded');
  perform public._t_assert((select acknowledged_flags -> 0 ->> 'code' from public.review_events where invoice_id = inv and action = 'verify') = 'possible_duplicate', 'acknowledged warnings are recorded');
  perform public._t_assert((select line_items from (select count(*) as line_items from public.line_items where invoice_id = inv) t) = 1, 'null items leave line items alone');

  select updated_at::text into ts from public.extracted_data where invoice_id = inv;
  r := public.save_invoice_review(fa, inv, usr, ts, 'save', hdr, '{}', '{}', null, '[{"code":"x","severity":"warning","message":"m"}]', 'needs_review', '{}', '[]');
  perform public._t_assert((select status from public.invoices where id = inv) = 'needs_review' and (select verified_at is null from public.extracted_data where invoice_id = inv), 'editing a verified invoice removes the verification');

  perform public._t_assert((select raw_extraction is null from public.extracted_data where invoice_id = inv), 'raw_extraction is untouched by review');

  update public.invoices set status = 'failed' where id = inv;
  select updated_at::text into ts from public.extracted_data where invoice_id = inv;
  r := public.save_invoice_review(fa, inv, usr, ts, 'save', hdr, '{}', '{}', null, '[]', 'completed', '{}', '[]');
  perform public._t_assert(r ->> 'result' = 'not_editable', 'a failed invoice cannot be edited');
end $$;

-- 5. record_export
do $$
declare fa uuid := (select firm_id from public.firm_members where user_id = '00000000-0000-4000-8000-00000000b001'); id uuid;
begin
  id := public.record_export(fa, '00000000-0000-4000-8000-00000000b001', 'xlsx', 'standard', array['00000000-0000-4000-8000-0000000b0a01']::uuid[], 2, array['invoice_number'], true, 'x.xlsx');
  perform public._t_assert((select invoice_count = 1 and skipped_count = 2 and include_items from public.export_history where export_history.id = id), 'export history records counts and options');
  perform public._t_assert((select count(*) from public.usage_records where firm_id = fa and kind = 'export') = 1, 'an export usage record was written');
  perform public._t_assert((public.review_summary(fa) ->> 'month_exports')::int = 1, 'summary counts the export');
end $$;
reset role;

rollback;
select 'PHASE 4 SQL TESTS PASSED' as result;
