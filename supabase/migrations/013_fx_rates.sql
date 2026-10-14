-- AI Asis: exchange rate cache for foreign currency (import / cross-border) invoices (migration 013).
-- The extraction fetches the INR rate of the invoice date from free public sources (Frankfurter / ECB, currency-api) when the
-- invoice prints no exchange rate. A past day's rate never changes, so it is cached here: the same currency + date is fetched
-- only once, later invoices are faster and keep exactly the same rate (repeatable, auditable).
-- Only the server (service role) reads and writes this table. RLS is on and there are no policies, so browsers can not touch it.
-- Nothing else changes: the rate used by an invoice is stored in extracted_data.exchange_rate (+ field_status.exchange_rate.source
-- = 'fetched') and the conversion details in extracted_data.validation_summary -> 'forex'. Safe to run before or after the app deploy.

create table if not exists public.fx_rates (
  currency text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'INR'),
  requested_date date not null,           -- the invoice date that was asked for
  rate_date date not null,                -- the date the rate was published for (last working day on or before requested_date)
  rate numeric(18, 6) not null check (rate > 0),
  source text not null check (source in ('frankfurter', 'currency-api', 'currency-api-mirror')),
  source_label text not null,
  fetched_at timestamptz not null default now(),
  primary key (currency, requested_date),
  check (rate_date <= requested_date)
);

alter table public.fx_rates enable row level security;
revoke all on public.fx_rates from public, anon, authenticated;
grant select, insert, update on public.fx_rates to service_role;
