-- AI Asis Phase 5 (Part 1): SaaS plans, subscriptions, quota ledger, plan changes.
-- Prerequisite: the earlier migrations (phase 2 to phase 4) have been applied. No enum changes, so this runs in one go.
--
-- Design notes
--  * Plans (prices and limits) live in the database and are configurable with plain SQL, no deploy needed.
--    The seed values are PROPOSED placeholders, not final commitments.
--  * Browsers can only READ plans, subscriptions, usage and billing events (RLS, firm members only).
--    Nothing here is writable by 'authenticated'. All changes go through SECURITY DEFINER functions
--    that only the server (service_role) can call, after the route has authorized the user.
--  * Quota unit = one invoice per billing period, kept in usage_ledger:
--      reserved  -> job queued/processing,  consumed -> AI work was done,  released -> free failure.
--    A retry of the same invoice in the same period never uses a second unit.
--    Failures caused by us or the AI provider (not by the invoice) release the unit.
--    The ledger has no foreign key to invoices, so deleting an invoice does not give quota back.
--  * Payment is NOT part of this phase. A paid upgrade is recorded as "upgrade_awaiting_payment" and does not
--    change the plan until the payment phase confirms it.

-- ---------------------------------------------------------------------------
-- 1. plans
-- ---------------------------------------------------------------------------
create table public.plans (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  name text not null check (char_length(name) between 1 and 60),
  tagline text check (tagline is null or char_length(tagline) <= 160),
  price_paise int not null check (price_paise >= 0),
  -- Set only for a price range such as CA Firm (price_paise = starting price, price_max_paise = top of range).
  price_max_paise int check (price_max_paise is null or price_max_paise >= price_paise),
  currency char(3) not null default 'INR',
  monthly_invoice_limit int not null check (monthly_invoice_limit >= 0),
  batch_max_files int not null check (batch_max_files between 1 and 100),
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array'),
  sort_order int not null default 0,
  is_active boolean not null default true,
  is_public boolean not null default true,
  is_proposed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger plans_updated_at before update on public.plans for each row execute function public.set_updated_at();

-- PROPOSED plans and limits. Change them with UPDATE statements; nothing else needs a deploy.
-- Prices are in paise: 79900 = INR 799.
insert into public.plans (code, name, tagline, price_paise, price_max_paise, monthly_invoice_limit, batch_max_files, features, sort_order) values
  ('pilot', 'Pilot', 'Try the workflow on real invoices', 0, null, 25, 5,
   '["25 invoices per month","Up to 5 files per upload","AI extraction with GST checks","Review, verify and export (CSV and Excel)"]'::jsonb, 10),
  ('solo', 'Solo', 'For a single CA or consultant', 79900, null, 300, 20,
   '["300 invoices per month","Up to 20 files per upload","AI extraction with GST checks","Review, verify and export (CSV and Excel)","Email support"]'::jsonb, 20),
  ('ca_firm', 'CA Firm', 'For firms handling many clients', 149900, 299900, 1500, 50,
   '["1,500 invoices per month","Up to 50 files per upload","AI extraction with GST checks","Review, verify and export (CSV and Excel)","Priority support"]'::jsonb, 30);

-- ---------------------------------------------------------------------------
-- 2. subscriptions: one row per firm (the tenant)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  firm_id uuid primary key references public.firms (id) on delete cascade,
  plan_code text not null references public.plans (code),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'suspended')),
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '1 month'),
  -- One scheduled change at most: a downgrade at period end, or an upgrade waiting for payment.
  pending_plan_code text references public.plans (code),
  pending_kind text check (pending_kind in ('downgrade', 'upgrade_awaiting_payment')),
  pending_effective_at timestamptz,
  -- Filled by the payment phase. While provider_subscription_id is set, the provider owns the period dates.
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_period_order check (current_period_end > current_period_start),
  constraint subscriptions_pending_pair check ((pending_plan_code is null) = (pending_kind is null))
);
create index subscriptions_plan_idx on public.subscriptions (plan_code);
create index subscriptions_pending_plan_idx on public.subscriptions (pending_plan_code) where pending_plan_code is not null;
create trigger subscriptions_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger subscriptions_firm_immutable before update on public.subscriptions for each row execute function public.forbid_firm_id_change();

-- ---------------------------------------------------------------------------
-- 3. usage_ledger: quota units per firm per billing period
-- ---------------------------------------------------------------------------
create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  invoice_id uuid not null, -- intentionally no FK: usage must survive deleting the invoice
  period_start timestamptz not null,
  period_end timestamptz not null,
  plan_code text not null,
  state text not null check (state in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, invoice_id, period_start)
);
create index usage_ledger_firm_period_idx on public.usage_ledger (firm_id, period_start, state);

-- ---------------------------------------------------------------------------
-- 4. billing_events: audit trail of plan changes and period changes
-- ---------------------------------------------------------------------------
create table public.billing_events (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  event text not null check (char_length(event) between 1 and 60),
  from_plan text,
  to_plan text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index billing_events_firm_created_idx on public.billing_events (firm_id, created_at desc);
create index billing_events_user_idx on public.billing_events (user_id) where user_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security: read-only for browsers, firm members only
-- ---------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.billing_events enable row level security;

grant select on public.plans to anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.usage_ledger to authenticated;
grant select on public.billing_events to authenticated;

create policy plans_select_public on public.plans for select to anon, authenticated
  using (is_public and is_active);
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (public.is_firm_member(firm_id));
create policy usage_ledger_select on public.usage_ledger for select to authenticated
  using (public.is_firm_member(firm_id));
create policy billing_events_select on public.billing_events for select to authenticated
  using (public.is_firm_member(firm_id));

-- ---------------------------------------------------------------------------
-- 6. Every firm has a subscription. New firms start on Pilot.
-- ---------------------------------------------------------------------------
create or replace function public.create_pilot_subscription()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.subscriptions (firm_id, plan_code) values (new.id, 'pilot') on conflict (firm_id) do nothing;
  return new;
end $$;
revoke all on function public.create_pilot_subscription() from public, anon, authenticated;

create trigger firms_create_subscription
  after insert on public.firms
  for each row execute function public.create_pilot_subscription();

-- Existing firms: Pilot, with the current UTC month as the period so this month's usage carries over.
insert into public.subscriptions (firm_id, plan_code, current_period_start, current_period_end)
select f.id, 'pilot',
       (date_trunc('month', now() at time zone 'utc') at time zone 'utc'),
       (date_trunc('month', now() at time zone 'utc') at time zone 'utc') + interval '1 month'
  from public.firms f
on conflict (firm_id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Failure classification and the ledger trigger
-- ---------------------------------------------------------------------------
-- A failure that is not the invoice's fault does not use quota (same list as Phase 3, plus a removed invoice).
create or replace function public.is_free_failure(p_code text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_code, '') = any (array[
    'provider_unavailable', 'provider_timeout', 'provider_rate_limited',
    'provider_auth', 'provider_model_unavailable', 'stale_timeout', 'internal_error', 'invoice_removed'
  ]);
$$;
revoke all on function public.is_free_failure(text) from public, anon;
grant execute on function public.is_free_failure(text) to authenticated, service_role;

-- Backfill this month's usage from existing jobs, once per invoice.
insert into public.usage_ledger (firm_id, invoice_id, period_start, period_end, plan_code, state)
select s.firm_id, j.invoice_id, s.current_period_start, s.current_period_end, s.plan_code,
       case when bool_or(j.status::text in ('completed', 'needs_review', 'failed')) then 'consumed' else 'reserved' end
  from public.subscriptions s
  join public.processing_jobs j on j.firm_id = s.firm_id and j.created_at >= s.current_period_start
 where j.status::text <> 'cancelled'
   and not (j.status::text = 'failed' and public.is_free_failure(j.error_code))
 group by s.firm_id, j.invoice_id, s.current_period_start, s.current_period_end, s.plan_code
on conflict (firm_id, invoice_id, period_start) do nothing;

-- Keeps the ledger in step with job outcomes. Runs inside the same transaction as the job update,
-- so a unit can never be reserved without a job or settled without an outcome.
create or replace function public.sync_usage_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_l public.usage_ledger%rowtype;
  v_job public.processing_jobs%rowtype;
  v_state text;
  v_other boolean;
begin
  if tg_op = 'DELETE' then
    -- A job that never finished disappears (its invoice was deleted): give the unit back.
    if old.status::text in ('queued', 'processing') then
      update public.usage_ledger l
         set state = 'released', updated_at = now()
       where l.firm_id = old.firm_id and l.invoice_id = old.invoice_id and l.state = 'reserved'
         and l.period_start <= old.created_at and l.period_end > old.created_at;
    end if;
    return old;
  end if;

  v_job := new;
  if v_job.status is not distinct from old.status then
    return new;
  end if;
  if v_job.status::text not in ('completed', 'needs_review', 'failed', 'cancelled') then
    return new;
  end if;

  select * into v_l
    from public.usage_ledger l
   where l.firm_id = v_job.firm_id and l.invoice_id = v_job.invoice_id
     and l.period_start <= v_job.created_at and l.period_end > v_job.created_at
     for update;
  if not found then
    return new; -- job created before Phase 5; nothing to settle
  end if;

  if v_job.status::text in ('completed', 'needs_review') then
    v_state := 'consumed';
  elsif v_job.status::text = 'failed' and not public.is_free_failure(v_job.error_code) then
    v_state := 'consumed';
  else
    -- Free failure or cancelled: release, unless an earlier run of this invoice already did billable work.
    select exists (
      select 1 from public.processing_jobs j
       where j.firm_id = v_job.firm_id and j.invoice_id = v_job.invoice_id and j.id <> v_job.id
         and j.created_at >= v_l.period_start and j.created_at < v_l.period_end
         and (j.status::text in ('completed', 'needs_review')
              or (j.status::text = 'failed' and not public.is_free_failure(j.error_code)))
    ) into v_other;
    v_state := case when v_other then 'consumed' else 'released' end;
  end if;

  update public.usage_ledger set state = v_state, updated_at = now() where id = v_l.id;
  return new;
end $$;
revoke all on function public.sync_usage_ledger() from public, anon, authenticated;

create trigger processing_jobs_ledger_update
  after update of status on public.processing_jobs
  for each row execute function public.sync_usage_ledger();
create trigger processing_jobs_ledger_delete
  after delete on public.processing_jobs
  for each row execute function public.sync_usage_ledger();

-- ---------------------------------------------------------------------------
-- 8. Batch size is enforced by the database too (browsers may insert into batches directly).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_plan_batch_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_max int;
begin
  select p.batch_max_files into v_max
    from public.subscriptions s
    join public.plans p on p.code = s.plan_code
   where s.firm_id = new.firm_id;
  if v_max is null then
    raise exception 'no_subscription' using errcode = '23514';
  end if;
  if new.file_count > v_max then
    raise exception 'batch_limit_exceeded' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.enforce_plan_batch_limit() from public, anon, authenticated;

create trigger batches_plan_limit
  before insert on public.batches
  for each row execute function public.enforce_plan_batch_limit();

-- ---------------------------------------------------------------------------
-- 9. Billing period rollover (internal). Applies a scheduled downgrade at the period boundary.
--    While a payment provider owns the subscription (provider_subscription_id set) it does nothing.
-- ---------------------------------------------------------------------------
create or replace function public.roll_subscription_period(p_firm_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
  v_from text;
begin
  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));
  select * into s from public.subscriptions where firm_id = p_firm_id for update;
  if not found or s.provider_subscription_id is not null or now() < s.current_period_end then
    return;
  end if;

  if s.pending_kind = 'downgrade' and s.pending_plan_code is not null then
    v_from := s.plan_code;
    s.plan_code := s.pending_plan_code;
    s.pending_plan_code := null;
    s.pending_kind := null;
    s.pending_effective_at := null;
    insert into public.billing_events (firm_id, event, from_plan, to_plan, detail)
    values (p_firm_id, 'downgrade_applied', v_from, s.plan_code, jsonb_build_object('at', s.current_period_end));
  end if;

  while now() >= s.current_period_end loop
    s.current_period_start := s.current_period_end;
    s.current_period_end := s.current_period_start + interval '1 month';
  end loop;

  update public.subscriptions
     set plan_code = s.plan_code,
         pending_plan_code = s.pending_plan_code,
         pending_kind = s.pending_kind,
         pending_effective_at = s.pending_effective_at,
         current_period_start = s.current_period_start,
         current_period_end = s.current_period_end
   where firm_id = p_firm_id;
end $$;
revoke all on function public.roll_subscription_period(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. billing_overview: plan, subscription and usage for the dashboard and pricing screens.
--     Callable by signed-in users, but only returns data for a firm they belong to.
-- ---------------------------------------------------------------------------
create or replace function public.billing_overview(p_firm_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
  p public.plans%rowtype;
  n public.plans%rowtype;
  v_used int;
begin
  if not public.is_firm_member(p_firm_id) then
    return null;
  end if;
  perform public.roll_subscription_period(p_firm_id);

  select * into s from public.subscriptions where firm_id = p_firm_id;
  if not found then
    return null;
  end if;
  select * into p from public.plans where code = s.plan_code;
  if s.pending_plan_code is not null then
    select * into n from public.plans where code = s.pending_plan_code;
  end if;

  select count(*) into v_used
    from public.usage_ledger l
   where l.firm_id = p_firm_id and l.period_start = s.current_period_start and l.state <> 'released';

  return jsonb_build_object(
    'plan', jsonb_build_object(
      'code', p.code, 'name', p.name, 'tagline', p.tagline,
      'price_paise', p.price_paise, 'price_max_paise', p.price_max_paise, 'currency', p.currency,
      'monthly_invoice_limit', p.monthly_invoice_limit, 'batch_max_files', p.batch_max_files,
      'features', p.features, 'sort_order', p.sort_order, 'is_proposed', p.is_proposed),
    'subscription', jsonb_build_object(
      'status', s.status,
      'current_period_start', s.current_period_start,
      'current_period_end', s.current_period_end,
      'pending', case when s.pending_plan_code is null then null else jsonb_build_object(
        'plan_code', s.pending_plan_code, 'plan_name', n.name, 'kind', s.pending_kind,
        'effective_at', s.pending_effective_at) end),
    'usage', jsonb_build_object(
      'used', v_used,
      'limit', p.monthly_invoice_limit,
      'remaining', greatest(p.monthly_invoice_limit - v_used, 0)),
    'can_process', s.status in ('active', 'trialing')
  );
end $$;
revoke all on function public.billing_overview(uuid) from public, anon;
grant execute on function public.billing_overview(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. enqueue_metered_jobs: the quota-enforcing replacement for enqueue_extraction_jobs.
--     Limits come from the firm's plan, not from the caller. Runs under the per-firm advisory lock.
--     Partial success: invoices that fit are queued, the rest are returned with a reason.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_metered_jobs(
  p_firm_id uuid,
  p_user_id uuid,
  p_invoice_ids uuid[],
  p_per_minute_limit int,
  p_max_runs int
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
  p public.plans%rowtype;
  v_inv record;
  v_job_id uuid;
  v_used int;
  v_units int := 0;
  v_queued int := 0;
  v_minute_used int;
  v_runs int;
  v_held boolean;
  v_enqueued jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if p_invoice_ids is null or coalesce(array_length(p_invoice_ids, 1), 0) = 0 then
    return jsonb_build_object('enqueued', v_enqueued, 'skipped', v_skipped);
  end if;
  if p_per_minute_limit < 0 or p_max_runs < 1 then
    raise exception 'invalid limits' using errcode = '22023';
  end if;
  if not exists (select 1 from public.firm_members m where m.firm_id = p_firm_id and m.user_id = p_user_id) then
    raise exception 'user is not a member of this firm' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));
  perform public.roll_subscription_period(p_firm_id);

  select * into s from public.subscriptions where firm_id = p_firm_id;
  if not found then
    return jsonb_build_object('error', 'no_subscription');
  end if;
  select * into p from public.plans where code = s.plan_code;
  if s.status not in ('active', 'trialing') then
    return jsonb_build_object('error', 'subscription_inactive', 'status', s.status);
  end if;
  if cardinality(p_invoice_ids) > p.batch_max_files then
    return jsonb_build_object('error', 'batch_limit', 'max', p.batch_max_files);
  end if;

  select count(*) into v_used
    from public.usage_ledger l
   where l.firm_id = p_firm_id and l.period_start = s.current_period_start and l.state <> 'released';
  select count(*) into v_minute_used
    from public.processing_jobs j
   where j.firm_id = p_firm_id and j.created_at >= now() - interval '1 minute';

  for v_inv in
    select i.id, i.status
      from public.invoices i
     where i.firm_id = p_firm_id and i.id = any (p_invoice_ids)
     order by i.created_at, i.id
       for update
  loop
    if v_inv.status in ('queued', 'processing') then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'already_queued');
      continue;
    end if;
    if v_inv.status not in ('uploaded', 'failed') then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'not_eligible');
      continue;
    end if;

    select count(*) into v_runs from public.processing_jobs j where j.invoice_id = v_inv.id;
    if v_runs >= p_max_runs then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'max_runs_reached');
      continue;
    end if;

    -- A retry of an invoice that already holds a unit in this period costs nothing extra.
    select exists (
      select 1 from public.usage_ledger l
       where l.firm_id = p_firm_id and l.invoice_id = v_inv.id
         and l.period_start = s.current_period_start and l.state <> 'released'
    ) into v_held;

    if not v_held and v_used + v_units >= p.monthly_invoice_limit then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'quota_exceeded');
      continue;
    end if;
    if v_minute_used + v_queued >= p_per_minute_limit then
      v_skipped := v_skipped || jsonb_build_object('invoice_id', v_inv.id, 'reason', 'rate_limited');
      continue;
    end if;

    insert into public.processing_jobs (invoice_id, firm_id, status, requested_by)
    values (v_inv.id, p_firm_id, 'queued', p_user_id)
    returning id into v_job_id;

    update public.invoices set status = 'queued' where id = v_inv.id and firm_id = p_firm_id;

    if not v_held then
      insert into public.usage_ledger (firm_id, invoice_id, period_start, period_end, plan_code, state)
      values (p_firm_id, v_inv.id, s.current_period_start, s.current_period_end, p.code, 'reserved')
      on conflict (firm_id, invoice_id, period_start)
      do update set state = 'reserved', plan_code = excluded.plan_code, updated_at = now();
      v_units := v_units + 1;
    end if;

    v_queued := v_queued + 1;
    v_enqueued := v_enqueued || jsonb_build_object('invoice_id', v_inv.id, 'job_id', v_job_id);
  end loop;

  return jsonb_build_object(
    'enqueued', v_enqueued,
    'skipped', v_skipped,
    'quota', jsonb_build_object(
      'used', v_used + v_units,
      'limit', p.monthly_invoice_limit,
      'remaining', greatest(p.monthly_invoice_limit - v_used - v_units, 0))
  );
end $$;

-- ---------------------------------------------------------------------------
-- 12. change_plan: upgrade and downgrade workflow (server only).
--     * Only firm owners and admins may change the plan.
--     * Downgrade (lower sort_order): scheduled for the end of the period. The current plan keeps working until then.
--       Choosing Pilot is also how a firm cancels a paid plan.
--     * Upgrade: if p_allow_unpaid_upgrade is false (the default in production) it is only recorded as
--       'upgrade_awaiting_payment' and the plan does NOT change. The payment phase will confirm it.
--     * Choosing the current plan again cancels a scheduled change.
-- ---------------------------------------------------------------------------
create or replace function public.change_plan(
  p_firm_id uuid,
  p_user_id uuid,
  p_new_plan text,
  p_allow_unpaid_upgrade boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.firm_role;
  s public.subscriptions%rowtype;
  cur public.plans%rowtype;
  nw public.plans%rowtype;
begin
  select m.role into v_role from public.firm_members m where m.firm_id = p_firm_id and m.user_id = p_user_id;
  if v_role is null or v_role not in ('owner', 'admin') then
    return jsonb_build_object('result', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('extraction:' || p_firm_id::text, 0));
  perform public.roll_subscription_period(p_firm_id);

  select * into s from public.subscriptions where firm_id = p_firm_id for update;
  if not found then
    return jsonb_build_object('result', 'no_subscription');
  end if;
  select * into cur from public.plans where code = s.plan_code;
  select * into nw from public.plans where code = p_new_plan and is_active and is_public;
  if not found then
    return jsonb_build_object('result', 'unknown_plan');
  end if;

  if nw.code = cur.code then
    if s.pending_plan_code is null then
      return jsonb_build_object('result', 'unchanged', 'plan_code', cur.code);
    end if;
    update public.subscriptions
       set pending_plan_code = null, pending_kind = null, pending_effective_at = null
     where firm_id = p_firm_id;
    insert into public.billing_events (firm_id, user_id, event, from_plan, to_plan, detail)
    values (p_firm_id, p_user_id, 'change_cancelled', cur.code, s.pending_plan_code, '{}'::jsonb);
    return jsonb_build_object('result', 'pending_cancelled', 'plan_code', cur.code);
  end if;

  if nw.sort_order > cur.sort_order then
    if p_allow_unpaid_upgrade then
      update public.subscriptions
         set plan_code = nw.code, pending_plan_code = null, pending_kind = null, pending_effective_at = null
       where firm_id = p_firm_id;
      insert into public.billing_events (firm_id, user_id, event, from_plan, to_plan, detail)
      values (p_firm_id, p_user_id, 'upgrade_applied', cur.code, nw.code, jsonb_build_object('payment', 'skipped_non_production'));
      return jsonb_build_object('result', 'upgraded', 'plan_code', nw.code);
    end if;
    update public.subscriptions
       set pending_plan_code = nw.code, pending_kind = 'upgrade_awaiting_payment', pending_effective_at = null
     where firm_id = p_firm_id;
    insert into public.billing_events (firm_id, user_id, event, from_plan, to_plan, detail)
    values (p_firm_id, p_user_id, 'upgrade_requested', cur.code, nw.code, '{}'::jsonb);
    return jsonb_build_object('result', 'payment_required', 'plan_code', cur.code, 'pending_plan_code', nw.code);
  end if;

  update public.subscriptions
     set pending_plan_code = nw.code, pending_kind = 'downgrade', pending_effective_at = s.current_period_end
   where firm_id = p_firm_id;
  insert into public.billing_events (firm_id, user_id, event, from_plan, to_plan, detail)
  values (p_firm_id, p_user_id, 'downgrade_scheduled', cur.code, nw.code, jsonb_build_object('effective_at', s.current_period_end));
  return jsonb_build_object('result', 'downgrade_scheduled', 'plan_code', cur.code,
                            'pending_plan_code', nw.code, 'effective_at', s.current_period_end);
end $$;

-- Only the server (service_role) may call these two.
revoke all on function public.enqueue_metered_jobs(uuid, uuid, uuid[], int, int) from public, anon, authenticated;
revoke all on function public.change_plan(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.enqueue_metered_jobs(uuid, uuid, uuid[], int, int) to service_role;
grant execute on function public.change_plan(uuid, uuid, text, boolean) to service_role;
