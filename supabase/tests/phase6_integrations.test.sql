-- AI Asis Phase 6 Part 2: database tests for integration_connections, sync_records and oauth_states (plain SQL):
-- cross-firm access, token columns unreadable by anon and authenticated, forged writes, constraints, duplicate
-- prevention and retry behaviour of claim_sync_record / finish_sync_record, and cascades.
--
-- HOW TO RUN (scratch / local Supabase database only, never production data):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_integrations.test.sql
--   or paste the whole file into the Supabase SQL Editor and run it once.
-- Prerequisite: ALL migrations 001 to 010 are applied. One transaction, rolled back at the end. The last output is
-- one row "PHASE 6 INTEGRATIONS SQL TESTS PASSED". A failed check stops the script with "TEST FAILED: <name>"; then run:  rollback;
-- STATUS: written, NOT executed (no PostgreSQL in the build environment). Expect small fixes on the first run.
-- Tokens in the fixtures are fake strings. No Google or Microsoft account is contacted.

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
  ('ua', '00000000-0000-4000-8000-0000000e0001'), ('ub', '00000000-0000-4000-8000-0000000e0002'), ('um', '00000000-0000-4000-8000-0000000e0003'),
  ('ia1', '00000000-0000-4000-8000-0000000e1001'), ('ia2', '00000000-0000-4000-8000-0000000e1002'), ('ib1', '00000000-0000-4000-8000-0000000e1003'),
  ('cna', '00000000-0000-4000-8000-0000000e2001'), ('cnb', '00000000-0000-4000-8000-0000000e2002');
select public._t_user(public._t_id('ua'));
select public._t_user(public._t_id('ub'));
select public._t_user(public._t_id('um'));
insert into public._t_ids select 'fa', m.firm_id from public.firm_members m where m.user_id = public._t_id('ua');
insert into public._t_ids select 'fb', m.firm_id from public.firm_members m where m.user_id = public._t_id('ub');
insert into public.firm_members (firm_id, user_id, role) values (public._t_id('fa'), public._t_id('um'), 'member');
insert into public.invoices (id, firm_id, uploaded_by, storage_path, original_filename, mime_type, size_bytes, sha256)
select public._t_id(v.n), public._t_id(v.f), public._t_id(v.u), public._t_id(v.f)::text || '/' || public._t_id(v.n)::text || '.pdf', v.n || '.pdf',
       'application/pdf', 1000, encode(sha256(convert_to(v.n, 'utf8')), 'hex')
from (values ('ia1', 'fa', 'ua'), ('ia2', 'fa', 'ua'), ('ib1', 'fb', 'ub')) v(n, f, u);
insert into public.integration_connections (id, firm_id, connected_by, provider, account_email, refresh_token_enc, access_token_enc, access_expires_at)
values (public._t_id('cna'), public._t_id('fa'), public._t_id('ua'), 'google_sheets', 'a@example.test', 'FAKE-ENC-REFRESH-A', 'FAKE-ENC-ACCESS-A', now() + interval '1 hour'),
       (public._t_id('cnb'), public._t_id('fb'), public._t_id('ub'), 'google_sheets', 'b@example.test', 'FAKE-ENC-REFRESH-B', 'FAKE-ENC-ACCESS-B', now() + interval '1 hour');
insert into public.sync_records (firm_id, connection_id, invoice_id, status, dedupe_key) values
  (public._t_id('fb'), public._t_id('cnb'), public._t_id('ib1'), 'synced', 'B-KEY-1');
insert into public.oauth_states (state_hash, firm_id, user_id, provider, code_verifier_enc, expires_at)
values (repeat('a', 64), public._t_id('fa'), public._t_id('ua'), 'google_sheets', 'FAKE-ENC-VERIFIER', now() + interval '10 minutes'),
       (repeat('b', 64), public._t_id('fb'), public._t_id('ub'), 'microsoft_excel', 'FAKE-ENC-VERIFIER', now() + interval '10 minutes');

-- ---------------------------------------------------------------- 1. structure: grants, RLS, token columns
do $$
begin
  perform public._t_assert((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.integration_connections'::regclass, 'public.sync_records'::regclass, 'public.oauth_states'::regclass)),
    'RLS is enabled on integration_connections, sync_records and oauth_states');
  perform public._t_assert((select count(*) from pg_policies where schemaname = 'public' and tablename = 'oauth_states') = 0, 'oauth_states has no policies (service role only)');
  perform public._t_assert(not has_column_privilege('authenticated', 'public.integration_connections', 'refresh_token_enc', 'select')
    and not has_column_privilege('authenticated', 'public.integration_connections', 'access_token_enc', 'select'), 'authenticated cannot select the token columns');
  perform public._t_assert(not has_any_column_privilege('anon', 'public.integration_connections', 'select')
    and not has_any_column_privilege('anon', 'public.sync_records', 'select')
    and not has_any_column_privilege('anon', 'public.oauth_states', 'select'), 'anon has no select privilege on any column of the three tables (tokens included)');
  perform public._t_assert(has_column_privilege('authenticated', 'public.integration_connections', 'status', 'select')
    and has_column_privilege('authenticated', 'public.integration_connections', 'account_email', 'select'), 'authenticated can read the non-secret columns (status, account email)');
  perform public._t_assert(not has_any_column_privilege('authenticated', 'public.integration_connections', 'insert')
    and not has_any_column_privilege('authenticated', 'public.integration_connections', 'update')
    and not has_table_privilege('authenticated', 'public.integration_connections', 'delete'), 'authenticated cannot insert, update or delete connections');
  perform public._t_assert(not has_any_column_privilege('authenticated', 'public.sync_records', 'insert')
    and not has_any_column_privilege('authenticated', 'public.sync_records', 'update')
    and not has_table_privilege('authenticated', 'public.sync_records', 'delete'), 'authenticated has read-only access to sync_records');
  perform public._t_assert(not has_any_column_privilege('authenticated', 'public.oauth_states', 'select')
    and not has_any_column_privilege('authenticated', 'public.oauth_states', 'insert')
    and not has_any_column_privilege('authenticated', 'public.oauth_states', 'update')
    and not has_table_privilege('authenticated', 'public.oauth_states', 'delete'), 'authenticated has no access at all to oauth_states');
  perform public._t_assert(has_table_privilege('service_role', 'public.integration_connections', 'select') and has_table_privilege('service_role', 'public.oauth_states', 'insert'),
    'the service role can use the three tables');
  perform public._t_assert(not has_function_privilege('authenticated', 'public.claim_sync_record(uuid, uuid, uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.claim_sync_record(uuid, uuid, uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.finish_sync_record(uuid, uuid, uuid, text, int, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.finish_sync_record(uuid, uuid, uuid, text, int, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.claim_sync_record(uuid, uuid, uuid, text)', 'execute')
    and has_function_privilege('service_role', 'public.finish_sync_record(uuid, uuid, uuid, text, int, text, text)', 'execute'), 'only the service role can call claim_sync_record and finish_sync_record');
end $$;

-- ---------------------------------------------------------------- 2. constraints (run as the database owner)
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider) values (public._t_id('fa'), 'dropbox')$q$) = '23514', 'unknown provider is rejected');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider) values (public._t_id('fa'), 'google_sheets')$q$) = '23505', 'one connection per provider per firm');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider, status) values (public._t_id('fa'), 'microsoft_excel', 'hacked')$q$) = '23514', 'unknown connection status is rejected');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider, target) values (public._t_id('fa'), 'microsoft_excel', '[1]'::jsonb)$q$) = '23514', 'target must be a JSON object');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider, mapping) values (public._t_id('fa'), 'microsoft_excel', '{}'::jsonb)$q$) = '23514', 'mapping must be a JSON array');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider, date_format) values (public._t_id('fa'), 'microsoft_excel', 'us')$q$) = '23514', 'unknown date format is rejected');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider, last_error) values (public._t_id('fa'), 'microsoft_excel', repeat('x', 501))$q$) = '23514', 'stored error text is limited to 500 characters');
select public._t_assert(public._t_try($q$update public.integration_connections set firm_id = public._t_id('fb') where id = public._t_id('cna')$q$) = 'P0001', 'a connection can never move to another firm');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id, status) values (public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'done')$q$) = '23514', 'unknown sync status is rejected');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id) values (public._t_id('fa'), public._t_id('cna'), public._t_id('ib1'))$q$) = '23503', 'a sync record cannot point at another firm''s invoice');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id) values (public._t_id('fa'), public._t_id('cnb'), public._t_id('ia1'))$q$) = '23503', 'a sync record cannot use another firm''s connection');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id, dedupe_key) values (public._t_id('fb'), public._t_id('cnb'), public._t_id('ib1'), repeat('k', 301))$q$) in ('23514', '23505'), 'dedupe keys are limited to 300 characters');
select public._t_assert(public._t_try($q$insert into public.oauth_states (state_hash, firm_id, user_id, provider, code_verifier_enc, expires_at)
  values ('not-hex', public._t_id('fa'), public._t_id('ua'), 'google_sheets', 'x', now())$q$) = '23514', 'OAuth state must be a SHA-256 hex digest (the raw state is never stored)');

-- ---------------------------------------------------------------- 3. owner of firm A (authenticated)
select set_config('request.jwt.claims', json_build_object('sub', public._t_id('ua'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', public._t_id('ua')::text, true);
set local role authenticated;
select public._t_assert((select count(*) from public.integration_connections) = 1 and (select firm_id from public.integration_connections) = public._t_id('fa'), 'A sees only firm A''s connection');
select public._t_assert(public._t_count($q$select count(*) from public.integration_connections where id = public._t_id('cnb')$q$) = 0, 'A cannot look up firm B''s connection by id');
select public._t_assert((select count(*) from public.sync_records) = 0 and public._t_count($q$select count(*) from public.sync_records where firm_id = public._t_id('fb')$q$) = 0, 'A sees none of firm B''s sync records');
select public._t_assert(public._t_try('select refresh_token_enc from public.integration_connections') = '42501', 'A cannot read the refresh token column');
select public._t_assert(public._t_try('select access_token_enc from public.integration_connections') = '42501', 'A cannot read the access token column');
select public._t_assert(public._t_try('select * from public.integration_connections') = '42501', 'select * on connections is refused for browser sessions (server code must list columns or use the service role)');
select public._t_assert(public._t_try('select id, provider, status, account_email, target, mapping, last_error, last_synced_at from public.integration_connections') like 'ok:%', 'the safe column list works');
select public._t_assert(public._t_try($q$update public.integration_connections set target = '{"spreadsheetId":"evil"}'::jsonb where id = public._t_id('cna')$q$) = '42501', 'A cannot change the target file from the browser');
select public._t_assert(public._t_try($q$update public.integration_connections set status = 'active', refresh_token_enc = 'stolen' where id = public._t_id('cna')$q$) = '42501', 'A cannot write token columns');
select public._t_assert(public._t_try($q$insert into public.integration_connections (firm_id, provider) values (public._t_id('fa'), 'microsoft_excel')$q$) = '42501', 'A cannot create a connection without the OAuth flow');
select public._t_assert(public._t_try($q$delete from public.integration_connections where id = public._t_id('cna')$q$) = '42501', 'A cannot delete a connection directly (disconnect goes through the server)');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id, status) values (public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'synced')$q$) = '42501', 'A cannot forge a "synced" record (that would block real syncing)');
select public._t_assert(public._t_try($q$update public.sync_records set status = 'synced'$q$) = '42501', 'A cannot edit sync records');
select public._t_assert(public._t_try($q$delete from public.sync_records$q$) = '42501', 'A cannot delete sync records');
select public._t_assert(public._t_try('select * from public.oauth_states') = '42501', 'A cannot read OAuth states');
select public._t_assert(public._t_try($q$insert into public.oauth_states (state_hash, firm_id, user_id, provider, code_verifier_enc, expires_at)
  values (repeat('c', 64), public._t_id('fa'), public._t_id('ua'), 'google_sheets', 'x', now() + interval '1 hour')$q$) = '42501', 'A cannot plant an OAuth state');
select public._t_assert(public._t_try($q$select public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'k')$q$) = '42501', 'A cannot call claim_sync_record');
select public._t_assert(public._t_try($q$select public.finish_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'synced', 1, null, null)$q$) = '42501', 'A cannot call finish_sync_record');
reset role;

-- ---------------------------------------------------------------- 4. plain member M of firm A, and signed-out users
select set_config('request.jwt.claims', json_build_object('sub', public._t_id('um'), 'role', 'authenticated')::text, true);
select set_config('request.jwt.claim.sub', public._t_id('um')::text, true);
set local role authenticated;
select public._t_assert((select count(*) from public.integration_connections where firm_id = public._t_id('fa')) = 1
  and (select count(*) from public.integration_connections where firm_id = public._t_id('fb')) = 0, 'a member sees firm A''s connection status (not secret) and nothing of firm B');
select public._t_assert(public._t_try('select refresh_token_enc from public.integration_connections') = '42501', 'a member cannot read tokens either');
reset role;

set local role anon;
select public._t_assert(public._t_count('select count(*) from public.integration_connections') = -1, 'anon cannot read connections');
select public._t_assert(public._t_try('select refresh_token_enc from public.integration_connections') = '42501', 'anon cannot read tokens');
select public._t_assert(public._t_count('select count(*) from public.sync_records') = -1, 'anon cannot read sync records');
select public._t_assert(public._t_count('select count(*) from public.oauth_states') = -1, 'anon cannot read OAuth states');
select public._t_assert(public._t_try($q$select public.claim_sync_record(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), null)$q$) = '42501', 'anon cannot call claim_sync_record');
reset role;

-- ---------------------------------------------------------------- 5. service role: tokens readable, duplicate prevention, retries
set local role service_role;
select public._t_assert(public._t_count('select count(*) from public.integration_connections where refresh_token_enc is not null') = 2, 'the service role can read the (encrypted) tokens');
select public._t_assert(public._t_count('select count(*) from public.oauth_states') = 2, 'the service role can read OAuth states');

select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'KEY-1') = 'claimed', 'first claim of an invoice is "claimed"');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'KEY-1') = 'in_progress', 'a second claim while the first is running is "in_progress" (no double write)');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'KEY-1') like 'duplicate_of:%', 'another invoice with the same invoice-number key is a duplicate while the first is in flight');
select public.finish_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'synced', 7, null, null);
select public._t_assert((select status = 'synced' and external_row = 7 and synced_at is not null and attempts = 1 from public.sync_records where invoice_id = public._t_id('ia1') and connection_id = public._t_id('cna')), 'finishing as synced stores the row number and time');
select public._t_assert((select last_synced_at is not null from public.integration_connections where id = public._t_id('cna')), 'a successful sync stamps last_synced_at on the connection');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'KEY-1') = 'already_synced', 'syncing the same invoice again is "already_synced"');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'KEY-1') = 'duplicate_of:' || public._t_id('ia1')::text, 'a different invoice with the same key is reported as a duplicate of the synced one');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'KEY-2') = 'claimed', 'a different key is claimed normally');
select public.finish_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'failed', null, repeat('c', 100), repeat('m', 900));
select public._t_assert((select status = 'failed' and char_length(error_code) = 60 and char_length(error_message) = 500 from public.sync_records where invoice_id = public._t_id('ia2') and connection_id = public._t_id('cna')), 'failure details are truncated (60 / 500 characters)');
select public._t_assert(public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'KEY-2') = 'claimed', 'a failed record can be retried');
select public._t_assert((select attempts = 2 and error_code is null and error_message is null and status = 'syncing' from public.sync_records where invoice_id = public._t_id('ia2') and connection_id = public._t_id('cna')), 'a retry counts the attempt and clears the old error');
select public.finish_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia1'), 'failed', null, 'late', 'a late failure must not undo a success');
select public._t_assert((select status = 'synced' from public.sync_records where invoice_id = public._t_id('ia1') and connection_id = public._t_id('cna')), 'a late failure report cannot overwrite a synced record');
select public._t_assert(public._t_try($q$select public.finish_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ia2'), 'done', 1, null, null)$q$) = '22023', 'finish_sync_record rejects an invalid status');
select public._t_assert(public._t_try($q$select public.claim_sync_record(public._t_id('fb'), public._t_id('cna'), public._t_id('ia1'), 'x')$q$) = 'P0002', 'claim refuses a connection that belongs to another firm');
select public._t_assert(public._t_try($q$select public.claim_sync_record(public._t_id('fa'), public._t_id('cna'), public._t_id('ib1'), 'x')$q$) = 'P0002', 'claim refuses an invoice that belongs to another firm');
select public._t_assert(public._t_try($q$insert into public.sync_records (firm_id, connection_id, invoice_id, status, dedupe_key)
  values (public._t_id('fa'), public._t_id('cna'), gen_random_uuid(), 'synced', 'KEY-1')$q$) in ('23503', '23505'), 'the database also blocks two synced rows with the same key (unique index)');
reset role;

-- ---------------------------------------------------------------- 6. cascades and revocation
update public.integration_connections set status = 'revoked', refresh_token_enc = null, access_token_enc = null, access_expires_at = null
 where id = public._t_id('cna');
select public._t_assert((select status = 'revoked' and refresh_token_enc is null and access_token_enc is null from public.integration_connections where id = public._t_id('cna')), 'revocation clears both stored tokens');
delete from public.invoices where id = public._t_id('ia1');
select public._t_assert((select count(*) from public.sync_records where invoice_id = public._t_id('ia1')) = 0, 'deleting an invoice removes its sync records');
delete from public.integration_connections where id = public._t_id('cna');
select public._t_assert((select count(*) from public.sync_records where connection_id = public._t_id('cna')) = 0, 'deleting a connection removes its sync records');
delete from auth.users where id = public._t_id('ub');
select public._t_assert((select count(*) from public.oauth_states where user_id = public._t_id('ub')) = 0, 'deleting a user removes their pending OAuth states');
delete from public.firms where id = public._t_id('fb');
select public._t_assert((select count(*) from public.integration_connections where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.sync_records where firm_id = public._t_id('fb')) = 0
  and (select count(*) from public.oauth_states where firm_id = public._t_id('fb')) = 0, 'deleting a firm removes its connections, sync records and OAuth states');

rollback;
select 'PHASE 6 INTEGRATIONS SQL TESTS PASSED' as result;
