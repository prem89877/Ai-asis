-- AI Asis Phase 2: schema. Run migrations in filename order.

create type public.firm_role as enum ('owner', 'admin', 'member');
create type public.invoice_status as enum
  ('uploaded', 'queued', 'processing', 'needs_review', 'verified', 'failed', 'pending_deletion');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.usage_kind as enum ('invoice_upload', 'extraction', 'export');

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.forbid_firm_id_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.firm_id is distinct from old.firm_id then
    raise exception 'firm_id cannot be changed';
  end if;
  return new;
end $$;

-- Profiles: one row per auth user.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Firms are the tenant boundary.
create table public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.firm_members (
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.firm_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (firm_id, user_id)
);
create index firm_members_user_idx on public.firm_members (user_id);

-- Client relationships: the firm's own clients.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  email text check (email is null or char_length(email) <= 254),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, firm_id)
);
create index clients_firm_idx on public.clients (firm_id, name);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  client_id uuid,
  uploaded_by uuid references auth.users (id) on delete set null,
  storage_path text not null,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status public.invoice_status not null default 'uploaded',
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, firm_id),
  -- A file path must live under its own firm's folder.
  constraint invoices_path_in_firm check (starts_with(storage_path, firm_id::text || '/')),
  -- Client must belong to the same firm as the invoice.
  constraint invoices_client_same_firm foreign key (client_id, firm_id)
    references public.clients (id, firm_id) on delete set null (client_id)
);
create index invoices_firm_created_idx on public.invoices (firm_id, created_at desc);
create index invoices_firm_status_idx on public.invoices (firm_id, status);
create index invoices_client_idx on public.invoices (client_id) where client_id is not null;
create index invoices_uploaded_by_idx on public.invoices (uploaded_by);
create unique index invoices_firm_sha256_uidx on public.invoices (firm_id, sha256);

create table public.extracted_data (
  invoice_id uuid primary key,
  firm_id uuid not null,
  vendor_name text,
  vendor_gstin text,
  buyer_gstin text,
  invoice_number text,
  invoice_date date,
  currency char(3) not null default 'INR',
  taxable_amount numeric(14, 2),
  cgst_amount numeric(14, 2),
  sgst_amount numeric(14, 2),
  igst_amount numeric(14, 2),
  total_amount numeric(14, 2),
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  review_flags jsonb not null default '[]'::jsonb,
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invoice_id, firm_id) references public.invoices (id, firm_id) on delete cascade
);
create index extracted_data_firm_idx on public.extracted_data (firm_id);

create table public.line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  firm_id uuid not null,
  position int not null check (position >= 1),
  description text,
  hsn_code text check (hsn_code is null or hsn_code ~ '^[0-9]{4,8}$'),
  quantity numeric(14, 3),
  unit_price numeric(14, 2),
  taxable_amount numeric(14, 2),
  gst_rate numeric(5, 2) check (gst_rate is null or gst_rate between 0 and 100),
  gst_amount numeric(14, 2),
  line_total numeric(14, 2),
  created_at timestamptz not null default now(),
  unique (invoice_id, position),
  foreign key (invoice_id, firm_id) references public.invoices (id, firm_id) on delete cascade
);
create index line_items_firm_idx on public.line_items (firm_id);

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  firm_id uuid not null,
  status public.job_status not null default 'queued',
  attempts int not null default 0 check (attempts >= 0),
  error_code text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (invoice_id, firm_id) references public.invoices (id, firm_id) on delete cascade
);
create index processing_jobs_firm_status_idx on public.processing_jobs (firm_id, status);
create index processing_jobs_invoice_idx on public.processing_jobs (invoice_id);

-- Usage records intentionally have no invoice FK so billing history survives deletions.
create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  kind public.usage_kind not null,
  quantity int not null default 1 check (quantity > 0),
  invoice_id uuid,
  recorded_at timestamptz not null default now()
);
create index usage_records_firm_kind_idx on public.usage_records (firm_id, kind, recorded_at desc);

create table public.export_history (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  format text not null check (format in ('xlsx', 'csv')),
  invoice_count int not null check (invoice_count >= 0),
  created_at timestamptz not null default now()
);
create index export_history_firm_idx on public.export_history (firm_id, created_at desc);

-- updated_at triggers
create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger firms_updated_at before update on public.firms for each row execute function public.set_updated_at();
create trigger clients_updated_at before update on public.clients for each row execute function public.set_updated_at();
create trigger invoices_updated_at before update on public.invoices for each row execute function public.set_updated_at();
create trigger extracted_data_updated_at before update on public.extracted_data for each row execute function public.set_updated_at();
create trigger processing_jobs_updated_at before update on public.processing_jobs for each row execute function public.set_updated_at();

-- firm_id is immutable on tenant-owned rows
create trigger clients_firm_immutable before update on public.clients for each row execute function public.forbid_firm_id_change();
create trigger invoices_firm_immutable before update on public.invoices for each row execute function public.forbid_firm_id_change();

-- New user -> profile + personal firm + owner membership.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  new_firm uuid;
  display text;
begin
  display := nullif(left(btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), 120), '');

  insert into public.profiles (id, full_name) values (new.id, display);

  insert into public.firms (name, created_by)
  values (coalesce(display || '''s firm', 'My firm'), new.id)
  returning id into new_firm;

  insert into public.firm_members (firm_id, user_id, role) values (new_firm, new.id, 'owner');
  return new;
end $$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
