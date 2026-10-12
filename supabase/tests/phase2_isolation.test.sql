-- AI Asis Phase 6 Part 2: security and isolation tests for the Phase 2 tables (authentication, tenant isolation, RLS,
-- private file access, deletion) plus a structural sweep over EVERY public table added in Phases 3 to 6 (plain SQL).
--
-- HOW TO RUN (scratch / local Supabase database only, never production data):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase2_isolation.test.sql
--   or paste the whole file into the Supabase SQL Editor and run it once.
-- Prerequisite: ALL migrations 001 to 010 are applied. Everything runs in one transaction that is rolled back,
-- so no test data is kept. The last output is one row "PHASE 2 ISOLATION SQL TESTS PASSED". A failed check stops the
-- script with "TEST FAILED: <name>"; then run:  rollback;
-- STATUS: written, NOT executed (no PostgreSQL in the build environment). Expect small fixes on the first run,
-- for example if a Supabase storage trigger or an extra NOT NULL column differs on your project version.
-- Files in storage.objects are never deleted here: current Supabase blocks direct SQL deletes on storage tables.

begin;

create function public._t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'TEST FAILED: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;
create function public._t_user(p_id uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_firm uuid;
begin
  -- The signup trigger creates the profile, a personal firm, the owner membership and a Pilot subscription.
  insert into auth.users (id, email) values (p_id, p_id::text || '@test.invalid');
  select m.firm_id into v_firm from public.firm_members m where m.user_id = p_id limit 1;
  return v_firm;
end $$;
create table public._t_ids (name text primary key, id uuid not null);
create function public._t_id(p text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public._t_ids where name = p;
$$;
-- Runs one statement as the CURRENT role and reports 'ok:<rows>' or the SQLSTATE (42501 = permission/RLS denied).
create function public._t_try(stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return sqlstate;
end $$;
-- Counts rows as the CURRENT role; -1 means the statement itself was denied.
create function public._t_count(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute stmt into n;
  return n;
exception when others then
  return -1;
end $$;
grant select on public._t_ids to anon, authenticated;
grant execute on function public._t_assert(boolean, text), public._t_id(text), public._t_try(text), public._t_count(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- fixtures
insert into public._t_ids values
  ('ua', '00000000-0000-4000-8000-0000000d0001'), ('ub', '00000000-0000-4000-8000-0000000d0002'), ('um', '00000000-0000-4000-8000-0000000d0003'),
  ('ia1', '00000000-0000-4000-8000-0000000d1001'), ('ia2', '00000000-0000-4000-8000-0000000d1002'),
  ('ia3', '00000000-0000-4000-8000-0000000d1003'), ('ib1', '00000000-0000-4000-8000-0000000d1004'),
  ('ca1', '00000000-0000-4000-8000-0000000d2001'), ('cb1', '00000000-0000-4000-8000-0000000d2002');
select public._t_user(public._t_id('ua'));
select public._t_user(public._t_id('ub'));
select public._t_user(public._t_id('um'));
insert into public._t_ids select 'fa', m.firm_id from public.firm_members m where m.user_id = public._t_id('ua');
insert into public._t_ids select 'fb', m.firm_id from public.firm_members m where m.user_id = public._t_id('ub');
-- M (plain member) also belongs to firm A, besides the personal firm the signup trigger gave M.
insert into public.firm_members (firm_id, user_id, role) values (public._t_id('fa'), public._t_id('um'), 'member');

insert into public.clients (id, firm_id, name, gstin) values
  (public._t_id('ca1'), public._t_id('fa'), 'Client A', '27AAPFU0939F1ZV'),
  (public._t_id('cb1'), public._t_id('fb'), 'Client B', '29AAACB1234C1Z5');
insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256)
select public._t_id(v.n), public._t_id(v.f), public._t_id(v.u),
       public._t_id(v.f)::text || '/' || public._t_id(v.n)::text || '.pdf', v.n || '.pdf', 'application/pdf', 1000,
       encode(sha256(convert_to(v.n, 'utf8')), 'hex')
from (values ('ia1', 'fa', 'ua'), ('ia2', 'fa', 'ua'), ('ia3', 'fa', 'um'), ('ib1', 'fb', 'ub')) v(n, f, u);
insert into public.extracted_data (invoice_id, firm_id)
select public._t_id(v.n), public._t_id(v.f) from (values ('ia1', 'fa'), ('ia2', 'fa'), ('ib1', 'fb')) v(n, f);
insert into public.line_items (invoice_id, firm_id, position)
select public._t_id(v.n), public._t_id(v.f), 1 from (values ('ia2', 'fa'), ('ib1', 'fb')) v(n, f);
insert into public.export_history (firm_id, format, invoice_count) values (public._t_id('fa'), 'csv', 1), (public._t_id('fb'), 'csv', 1);
insert into public.usage_records (firm_id, kind) values (public._t_id('fa'), 'export'), (public._t_id('fb'), 'export');
insert into storage.objects (bucket_id, name) values
  ('invoices', public._t_id('fa')::text || '/' || public._t_id('ia1')::text || '.pdf'),
  ('invoices', public._t_id('fb')::text || '/' || public._t_id('ib1')::text || '.pdf');

-- ---------------------------------------------------------------- 1. structure (all phases)
do $$
declare v text;
begin
  perform public._t_assert(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname not like '\_t\_%'),
    'every public table has Row Level Security enabled (Phases 2 to 6)');
  select string_agg(tablename || '.' || policyname, ', ') into v from pg_policies
   where schemaname = 'public' and policyname <> 'plans_select_public' and (qual = 'true' or with_check = 'true');
  perform public._t_assert(v is null, 'no public policy is "using (true)" except the public plans list' || coalesce(' (found: ' || v || ')', ''));
  select string_agg(distinct table_name, ', ') into v from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public' and table_name <> 'plans' and table_name not like '\_t\_%';
  perform public._t_assert(v is null, 'the anon role has no table privileges except reading plans' || coalesce(' (found: ' || v || ')', ''));
  select string_agg(p.proname, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.proname not like '\_t\_%' and has_function_privilege('anon', p.oid, 'execute');
  perform public._t_assert(v is null, 'anon cannot execute any SECURITY DEFINER function' || coalesce(' (found: ' || v || ')', ''));
  select string_agg(p.proname, ', ') into v from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and p.proname in ('enqueue_extraction_jobs', 'claim_extraction_job', 'complete_extraction_job', 'save_invoice_review', 'record_export',
                       'enqueue_metered_jobs', 'change_plan', 'claim_sync_record', 'finish_sync_record', 'roll_subscription_period',
                       'create_pilot_subscription', 'handle_new_user', 'sync_usage_ledger')
     and has_function_privilege('authenticated', p.oid, 'execute');
  perform public._t_assert(v is null, 'signed-in users cannot execute server-only functions (extraction, review, export, billing, sync)' || coalesce(' (found: ' || v || ')', ''));
  perform public._t_assert((select count(*) from pg_class c where c.relname in ('invoice_review_list', 'extraction_usage_monthly')
      and 'security_invoker=true' = any (c.reloptions)) = 2, 'both reporting views run with the caller''s RLS (security_invoker)');
  perform public._t_assert((select not public and file_size_limit = 4194304 and allowed_mime_types @> array['application/pdf', 'image/jpeg', 'image/png']
      and cardinality(allowed_mime_types) = 3 from storage.buckets where id = 'invoices'), 'invoice bucket is private, 4 MB, PDF/JPEG/PNG only');
  perform public._t_assert((select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('invoices_objects_select', 'invoices_objects_insert', 'invoices_objects_delete')) = 3, 'storage policies exist for select, insert and delete');
  -- Positive controls: firm B really has rows in these tables, so the "sees nothing" checks below are meaningful.
  perform public._t_assert((select count(*) from public.clients where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.invoices where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.extracted_data where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.line_items where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.export_history where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.usage_records where firm_id = public._t_id('fb')) = 1
    and (select count(*) from public.subscriptions where firm_id = public._t_id('fb')) = 1, 'fixtures: firm B has data in every seeded table');
end $$;

-- ---------------------------------------------------------------- 2. owner of firm A: reads (cross-tenant isolation)
select set_config('request.jwt.claims', json_build_object('sub', public._t_id('ua'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', public._t_id('ua')::text, true);
set local role authenticated;

select public._t_assert((select count(*) from public.firms) = 1 and (select id from public.firms) = public._t_id('fa'), 'A sees only their own firm');
select public._t_assert((select count(*) from public.profiles) = 1, 'A sees only their own profile');
select public._t_assert((select count(*) from public.firm_members) = 2 and (select count(*) from public.firm_members where firm_id = public._t_id('fb')) = 0, 'A sees the members of firm A only');
select public._t_assert((select count(*) from public.invoices) = 3, 'A sees all 3 invoices of firm A and none of firm B (no filter used)');
select public._t_assert((select count(*) from public.clients) = 1 and (select count(*) from public.extracted_data) = 2
  and (select count(*) from public.line_items) = 1 and (select count(*) from public.export_history) = 1, 'A sees only firm A rows in clients, extracted_data, line_items and export_history');
select public._t_assert((select count(*) from public.usage_records where firm_id <> public._t_id('fa')) = 0, 'A sees no usage records of other firms');
select public._t_assert((select count(*) from public.invoice_review_list where firm_id = public._t_id('fb')) = 0, 'the review list view hides other firms');
do $$
declare t text; n bigint;
begin
  foreach t in array array['clients', 'invoices', 'extracted_data', 'line_items', 'processing_jobs', 'usage_records', 'export_history', 'batches',
                           'review_events', 'export_preferences', 'subscriptions', 'usage_ledger', 'billing_events', 'integration_connections', 'sync_records'] loop
    execute format('select count(*) from public.%I where firm_id = public._t_id(%L)', t, 'fb') into n;
    perform public._t_assert(n = 0, 'A sees no ' || t || ' rows of firm B');
  end loop;
end $$;
select public._t_assert(public.is_firm_member(public._t_id('fa')) and not public.is_firm_member(public._t_id('fb')), 'is_firm_member is true for own firm and false for another firm');
select public._t_assert(public.has_firm_role(public._t_id('fa'), array['owner']::public.firm_role[]) and not public.has_firm_role(public._t_id('fb'), array['owner', 'admin', 'member']::public.firm_role[]), 'has_firm_role is false for a firm the user does not belong to');

-- ---------------------------------------------------------------- 3. owner of firm A: writes against firm B and forged writes
select public._t_assert(public._t_try($q$insert into public.clients (firm_id, name) values (public._t_id('fb'), 'Intruder')$q$) = '42501', 'A cannot create a client in firm B');
select public._t_assert(public._t_try($q$insert into public.invoices (firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256)
  values (public._t_id('fb'), public._t_id('ua'), public._t_id('fb')::text || '/x.pdf', 'x.pdf', 'application/pdf', 10, repeat('a', 64))$q$) = '42501', 'A cannot upload an invoice into firm B');
select public._t_assert(public._t_try($q$insert into public.invoices (firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256)
  values (public._t_id('fa'), public._t_id('ub'), public._t_id('fa')::text || '/y.pdf', 'y.pdf', 'application/pdf', 10, repeat('b', 64))$q$) = '42501', 'A cannot upload an invoice in someone else''s name');
select public._t_assert(public._t_try($q$insert into public.invoices (firm_id, uploaded_by, status, storage_path, original_filename, mime_type, size_bytes, sha256)
  values (public._t_id('fa'), public._t_id('ua'), 'verified', public._t_id('fa')::text || '/z.pdf', 'z.pdf', 'application/pdf', 10, repeat('c', 64))$q$) = '42501', 'A cannot upload an invoice that is already "verified"');
select public._t_assert(public._t_try($q$insert into public.invoices (firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256)
  values (public._t_id('fa'), public._t_id('ua'), public._t_id('fb')::text || '/w.pdf', 'w.pdf', 'application/pdf', 10, repeat('d', 64))$q$) = '23514', 'a storage path outside the firm folder is rejected by the database');
select public._t_assert(public._t_try($q$update public.invoices set original_filename = 'hacked.pdf' where id = public._t_id('ib1')$q$) = 'ok:0', 'A cannot rename firm B''s invoice (row invisible, 0 rows)');
select public._t_assert(public._t_try($q$update public.invoices set firm_id = public._t_id('fb') where id = public._t_id('ia1')$q$) in ('42501', 'P0001'), 'A cannot move an invoice to another firm');
select public._t_assert(public._t_try($q$update public.invoices set status = 'verified' where id = public._t_id('ia1')$q$) = '42501', 'A cannot mark an invoice verified or completed from the browser');
select public._t_assert(public._t_try($q$update public.invoices set client_id = public._t_id('cb1') where id = public._t_id('ia1')$q$) = '23503', 'an invoice cannot be linked to a client of another firm');
select public._t_assert(public._t_try($q$update public.clients set name = 'x' where id = public._t_id('cb1')$q$) = 'ok:0', 'A cannot edit firm B''s client');
select public._t_assert(public._t_try($q$update public.firms set name = 'Mine now' where id = public._t_id('fb')$q$) = 'ok:0', 'A cannot rename firm B');
select public._t_assert(public._t_try($q$update public.profiles set full_name = 'x' where id = public._t_id('ub')$q$) = 'ok:0', 'A cannot edit another user''s profile');
select public._t_assert(public._t_try($q$update public.firm_members set role = 'owner' where user_id = public._t_id('um')$q$) = '42501', 'nobody can change roles from the browser');
select public._t_assert(public._t_try($q$insert into public.firm_members (firm_id, user_id, role) values (public._t_id('fb'), public._t_id('ua'), 'owner')$q$) = '42501', 'A cannot add themselves to firm B');
select public._t_assert(public._t_try($q$insert into public.extracted_data (invoice_id, firm_id) values (public._t_id('ib1'), public._t_id('fb'))$q$) = '42501', 'browsers cannot write extraction results');
select public._t_assert(public._t_try($q$update public.extracted_data set total_amount = 1 where invoice_id = public._t_id('ia1')$q$) = '42501', 'browsers cannot edit extracted data directly (only the server''s review function can)');
select public._t_assert(public._t_try($q$insert into public.line_items (invoice_id, firm_id, position) values (public._t_id('ia1'), public._t_id('fa'), 9)$q$) = '42501', 'browsers cannot write line items');
select public._t_assert(public._t_try($q$insert into public.usage_records (firm_id, kind) values (public._t_id('fa'), 'extraction')$q$) = '42501', 'browsers cannot write usage records');
select public._t_assert(public._t_try($q$insert into public.export_history (firm_id, format, invoice_count) values (public._t_id('fa'), 'csv', 1)$q$) = '42501', 'browsers cannot forge export history');
select public._t_assert(public._t_try($q$insert into public.processing_jobs (invoice_id, firm_id) values (public._t_id('ia1'), public._t_id('fa'))$q$) = '42501', 'browsers cannot create processing jobs');
select public._t_assert(public._t_try($q$delete from public.firm_members where user_id = public._t_id('ua')$q$) = 'ok:0', 'the owner cannot remove their own owner membership');
select public._t_assert(public._t_try($q$delete from public.firms where id = public._t_id('fa')$q$) = '42501', 'firms cannot be deleted from the browser');

-- ---------------------------------------------------------------- 4. private file access (storage) as A
select public._t_assert((select count(*) from storage.objects where bucket_id = 'invoices') = 1
  and (select name from storage.objects where bucket_id = 'invoices') like public._t_id('fa')::text || '/%', 'A sees only files in firm A''s folder');
select public._t_assert((select count(*) from storage.objects where bucket_id = 'invoices' and name like public._t_id('fb')::text || '/%') = 0, 'A cannot see (so cannot sign or download) firm B''s files');
select public._t_assert(public._t_try($q$insert into storage.objects (bucket_id, name) values ('invoices', public._t_id('fb')::text || '/evil.pdf')$q$) = '42501', 'A cannot upload into firm B''s folder');
select public._t_assert(public._t_try($q$insert into storage.objects (bucket_id, name) values ('invoices', 'not-a-uuid/evil.pdf')$q$) = '42501', 'a folder that is not a firm id is refused');
select public._t_assert(public._t_try($q$insert into storage.objects (bucket_id, name) values ('invoices', 'evil.pdf')$q$) = '42501', 'a file at the bucket root is refused');
select public._t_assert(public._t_try($q$insert into storage.objects (bucket_id, name) values ('invoices', public._t_id('fa')::text || '/new.pdf')$q$) = 'ok:1', 'A can upload into their own firm folder');
select public._t_assert(public._t_try($q$delete from storage.objects where bucket_id = 'invoices' and name like public._t_id('fb')::text || '/%'$q$) in ('ok:0', '42501', 'P0001'), 'A cannot delete firm B''s files');
reset role;
select public._t_assert((select count(*) from storage.objects where bucket_id = 'invoices' and name like public._t_id('fb')::text || '/%') = 1, 'firm B''s file is still there');

-- ---------------------------------------------------------------- 5. plain member M of firm A
select set_config('request.jwt.claims', json_build_object('sub', public._t_id('um'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', public._t_id('um')::text, true);
set local role authenticated;
select public._t_assert((select count(*) from public.invoices where firm_id = public._t_id('fa')) = 3 and (select count(*) from public.invoices where firm_id = public._t_id('fb')) = 0, 'M sees firm A''s invoices and nothing of firm B');
select public._t_assert(public._t_try($q$update public.firms set name = 'M renames' where id = public._t_id('fa')$q$) = 'ok:0', 'a plain member cannot rename the firm');
select public._t_assert(public._t_try($q$delete from public.clients where id = public._t_id('ca1')$q$) = 'ok:0', 'a plain member cannot delete clients (owners and admins only)');
select public._t_assert(public._t_try($q$delete from public.invoices where id = public._t_id('ia1')$q$) = 'ok:0', 'a member cannot delete an invoice uploaded by someone else');
select public._t_assert(public._t_try($q$delete from public.invoices where id = public._t_id('ia3')$q$) = 'ok:1', 'a member can delete their own upload');
select public._t_assert(public._t_try($q$delete from public.firm_members where user_id = public._t_id('um') and firm_id = public._t_id('fa')$q$) = 'ok:1', 'a member can leave the firm');
select public._t_assert((select count(*) from public.invoices where firm_id = public._t_id('fa')) = 0 and (select count(*) from storage.objects where bucket_id = 'invoices') = 0, 'after leaving, M sees no invoices and no files of firm A');
reset role;

-- ---------------------------------------------------------------- 6. owner of firm A: deletion and cascades
select set_config('request.jwt.claims', json_build_object('sub', public._t_id('ua'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', public._t_id('ua')::text, true);
set local role authenticated;
select public._t_assert(public._t_try($q$update public.invoices set client_id = public._t_id('ca1') where id = public._t_id('ia1')$q$) = 'ok:1', 'A links an invoice to their own client');
select public._t_assert(public._t_try($q$delete from public.invoices where id = public._t_id('ib1')$q$) = 'ok:0', 'A cannot delete firm B''s invoice');
select public._t_assert(public._t_try($q$delete from public.clients where id = public._t_id('ca1')$q$) = 'ok:1', 'an owner can delete a client');
select public._t_assert(public._t_try($q$delete from public.invoices where id = public._t_id('ia2')$q$) = 'ok:1', 'an owner can delete an invoice');
reset role;
select public._t_assert((select client_id is null from public.invoices where id = public._t_id('ia1')), 'deleting a client keeps its invoices (client link cleared)');
select public._t_assert((select count(*) from public.extracted_data where invoice_id = public._t_id('ia2')) = 0
  and (select count(*) from public.line_items where invoice_id = public._t_id('ia2')) = 0, 'deleting an invoice removes its extracted data and line items');
select public._t_assert((select count(*) from public.invoices where id = public._t_id('ib1')) = 1, 'firm B''s invoice is untouched');

-- Account deletion: this documents the CURRENT behaviour, which is an operational limitation (see docs/OPERATIONS.md).
delete from auth.users where id = public._t_id('ub');
select public._t_assert((select count(*) from public.firm_members where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.firms where id = public._t_id('fb')) = 1
  and (select count(*) from public.invoices where firm_id = public._t_id('fb')) = 1, 'KNOWN LIMITATION: deleting a user''s account leaves the firm, its invoices and files in place (orphaned) until the firm itself is deleted');
delete from public.firms where id = public._t_id('fb');
select public._t_assert((select count(*) from public.invoices where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.clients where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.extracted_data where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.line_items where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.export_history where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.usage_records where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.subscriptions where firm_id = public._t_id('fb')) = 0, 'deleting a firm removes all its database rows (every tenant table cascades)');
select public._t_assert((select count(*) from storage.objects where bucket_id = 'invoices' and name like public._t_id('fb')::text || '/%') = 1,
  'KNOWN LIMITATION: deleting a firm in SQL does NOT delete its files; remove them with the Storage API / dashboard (see docs/OPERATIONS.md)');
select public._t_assert((select count(*) from public.invoices where firm_id = public._t_id('fa')) = 1, 'firm A''s data is untouched by all of this');

-- ---------------------------------------------------------------- 7. signed-out (anon) role
set local role anon;
select public._t_assert(public._t_count('select count(*) from public.invoices') = -1, 'anon cannot read invoices');
select public._t_assert(public._t_count('select count(*) from public.firms') = -1, 'anon cannot read firms');
select public._t_assert(public._t_count('select count(*) from public.extracted_data') = -1, 'anon cannot read extracted data');
select public._t_assert(public._t_count('select count(*) from public.invoice_review_list') = -1, 'anon cannot read the review list');
select public._t_assert(public._t_try($q$insert into public.firms (name) values ('anon firm')$q$) = '42501', 'anon cannot create firms');
select public._t_assert(public._t_count('select count(*) from storage.objects where bucket_id = ''invoices''') in (-1, 0), 'anon sees no invoice files');
select public._t_assert(public._t_count('select count(*) from public.plans') >= 3, 'anon can read the public plans list');
reset role;

rollback;
select 'PHASE 2 ISOLATION SQL TESTS PASSED' as result;
