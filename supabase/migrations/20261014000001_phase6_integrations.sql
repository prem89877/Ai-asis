-- AI Asis Phase 6, Part 1: Google Sheets / Microsoft Excel connections and sync records.
-- Prerequisite: all earlier migrations applied. Run in the Supabase SQL editor or with `supabase db push`.
-- STATUS: written, NOT executed against a real database in the build environment. Run it on a scratch project first.
--
-- Design notes
--  * Cloud tokens are stored ENCRYPTED (AES-256-GCM, done in the app with INTEGRATION_ENCRYPTION_KEY), never in plain text.
--  * Browsers can read only the non-secret columns of integration_connections (column-level grant). Token columns are
--    unreadable to the anon and authenticated roles. All writes go through server routes using the service role.
--  * sync_records is the duplicate-prevention ledger: one row per (connection, invoice), plus a "dedupe key"
--    (supplier GSTIN + invoice number + financial year) so the same real invoice uploaded twice is not appended twice.

-- ---------------------------------------------------------------------------
-- 1. integration_connections
-- ---------------------------------------------------------------------------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  connected_by uuid references auth.users (id) on delete set null,
  provider text not null check (provider in ('google_sheets', 'microsoft_excel')),
  account_email text check (account_email is null or char_length(account_email) <= 254),
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'revoked')),
  scopes text check (scopes is null or char_length(scopes) <= 1000),
  -- SECRET columns: AES-256-GCM ciphertext. Not readable by browsers.
  refresh_token_enc text,
  access_token_enc text,
  access_expires_at timestamptz,
  -- Chosen spreadsheet / workbook / worksheet (ids and names only, no secrets).
  target jsonb not null default '{}'::jsonb check (jsonb_typeof(target) = 'object'),
  -- Ordered list of { header, field } in destination column order.
  mapping jsonb not null default '[]'::jsonb check (jsonb_typeof(mapping) = 'array'),
  date_format text not null default 'iso' check (date_format in ('iso', 'dmy')),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_error_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, provider),
  unique (id, firm_id)
);
create index integration_connections_connected_by_idx on public.integration_connections (connected_by);

create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function public.set_updated_at();
create trigger integration_connections_firm_lock before update on public.integration_connections
  for each row execute function public.forbid_firm_id_change();

alter table public.integration_connections enable row level security;
revoke all on public.integration_connections from anon, authenticated;
-- Column-level grant: everything EXCEPT refresh_token_enc, access_token_enc, access_expires_at.
grant select (id, firm_id, connected_by, provider, account_email, status, scopes, target, mapping, date_format,
              last_error, last_error_at, last_synced_at, created_at, updated_at)
  on public.integration_connections to authenticated;
create policy integration_connections_select on public.integration_connections for select to authenticated
  using (public.is_firm_member(firm_id));

-- ---------------------------------------------------------------------------
-- 2. sync_records: what was sent where, and why something failed
-- ---------------------------------------------------------------------------
create table public.sync_records (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null,
  connection_id uuid not null,
  invoice_id uuid not null,
  status text not null default 'syncing' check (status in ('syncing', 'synced', 'failed')),
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 300),
  attempts int not null default 0 check (attempts >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  external_row int,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, invoice_id),
  foreign key (connection_id, firm_id) references public.integration_connections (id, firm_id) on delete cascade,
  foreign key (invoice_id, firm_id) references public.invoices (id, firm_id) on delete cascade
);
create index sync_records_firm_updated_idx on public.sync_records (firm_id, updated_at desc);
create index sync_records_invoice_idx on public.sync_records (invoice_id);
create unique index sync_records_dedupe_uidx on public.sync_records (connection_id, dedupe_key)
  where status = 'synced' and dedupe_key is not null;

create trigger sync_records_updated_at before update on public.sync_records
  for each row execute function public.set_updated_at();

alter table public.sync_records enable row level security;
revoke all on public.sync_records from anon, authenticated;
grant select on public.sync_records to authenticated;
create policy sync_records_select on public.sync_records for select to authenticated
  using (public.is_firm_member(firm_id));

-- ---------------------------------------------------------------------------
-- 3. oauth_states: single-use CSRF state + PKCE verifier (server only, no browser access at all)
-- ---------------------------------------------------------------------------
create table public.oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google_sheets', 'microsoft_excel')),
  code_verifier_enc text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index oauth_states_user_idx on public.oauth_states (user_id);
create index oauth_states_firm_idx on public.oauth_states (firm_id);
create index oauth_states_expires_idx on public.oauth_states (expires_at);
alter table public.oauth_states enable row level security;   -- no policies and no grants: service role only
revoke all on public.oauth_states from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. claim_sync_record(): atomic duplicate prevention. SERVER ONLY.
--    Returns: 'claimed' | 'already_synced' | 'in_progress' | 'duplicate_of:<invoice id>'
-- ---------------------------------------------------------------------------
create or replace function public.claim_sync_record(
  p_firm_id uuid, p_connection_id uuid, p_invoice_id uuid, p_dedupe_key text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.sync_records;
  v_other uuid;
begin
  if not exists (select 1 from public.integration_connections c where c.id = p_connection_id and c.firm_id = p_firm_id) then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.invoices i where i.id = p_invoice_id and i.firm_id = p_firm_id) then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;

  if p_dedupe_key is not null then
    -- Serialise claims for the same real-world invoice so two parallel runs cannot both pass the check below.
    perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text || '|' || p_dedupe_key, 0));
    select r.invoice_id into v_other
      from public.sync_records r
     where r.connection_id = p_connection_id
       and r.dedupe_key = p_dedupe_key
       and r.invoice_id <> p_invoice_id
       and (r.status = 'synced' or (r.status = 'syncing' and r.updated_at > now() - interval '3 minutes'))
     limit 1;
    if found then
      return 'duplicate_of:' || v_other::text;
    end if;
  end if;

  select * into v_row from public.sync_records r
   where r.connection_id = p_connection_id and r.invoice_id = p_invoice_id for update;
  if not found then
    insert into public.sync_records (firm_id, connection_id, invoice_id, status, dedupe_key, attempts)
    values (p_firm_id, p_connection_id, p_invoice_id, 'syncing', p_dedupe_key, 1);
    return 'claimed';
  end if;
  if v_row.status = 'synced' then
    return 'already_synced';
  end if;
  if v_row.status = 'syncing' and v_row.updated_at > now() - interval '3 minutes' then
    return 'in_progress';
  end if;
  update public.sync_records
     set status = 'syncing', dedupe_key = p_dedupe_key, attempts = attempts + 1, error_code = null, error_message = null
   where id = v_row.id;
  return 'claimed';
end $$;

-- ---------------------------------------------------------------------------
-- 5. finish_sync_record(): mark a claimed row synced or failed. SERVER ONLY.
-- ---------------------------------------------------------------------------
create or replace function public.finish_sync_record(
  p_firm_id uuid, p_connection_id uuid, p_invoice_id uuid, p_status text,
  p_external_row int, p_error_code text, p_error_message text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('synced', 'failed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  update public.sync_records
     set status = p_status,
         external_row = case when p_status = 'synced' then p_external_row else external_row end,
         synced_at = case when p_status = 'synced' then now() else synced_at end,
         error_code = case when p_status = 'failed' then left(p_error_code, 60) else null end,
         error_message = case when p_status = 'failed' then left(p_error_message, 500) else null end
   where firm_id = p_firm_id and connection_id = p_connection_id and invoice_id = p_invoice_id and status = 'syncing';
  if p_status = 'synced' then
    update public.integration_connections set last_synced_at = now()
     where id = p_connection_id and firm_id = p_firm_id;
  end if;
end $$;

revoke all on function public.claim_sync_record(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_sync_record(uuid, uuid, uuid, text) to service_role;
revoke all on function public.finish_sync_record(uuid, uuid, uuid, text, int, text, text) from public, anon, authenticated;
grant execute on function public.finish_sync_record(uuid, uuid, uuid, text, int, text, text) to service_role;
