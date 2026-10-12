-- Phase 4 follow-up: exports are downloaded through a normal link (GET /api/exports/:id/download), which the browser
-- never blocks, instead of a script-made blob download (blocked by some Android browsers after the first one).
-- The file is rebuilt from the saved export request, so history needs the full request. Files are still not stored:
-- a repeat download reflects the CURRENT invoice values.
alter table public.export_history
  add column if not exists item_columns text[] not null default '{}',
  add column if not exists date_format text not null default 'iso' check (date_format in ('iso', 'dmy')),
  add column if not exists verified_only boolean not null default false;

drop function if exists public.record_export(uuid, uuid, text, text, uuid[], int, text[], boolean, text);

create or replace function public.record_export(
  p_firm_id uuid,
  p_user_id uuid,
  p_format text,
  p_profile text,
  p_invoice_ids uuid[],
  p_skipped int,
  p_column_keys text[],
  p_include_items boolean,
  p_file_name text,
  p_item_columns text[],
  p_date_format text,
  p_verified_only boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_format not in ('xlsx', 'csv') then
    raise exception 'invalid format' using errcode = '22023';
  end if;
  if p_date_format not in ('iso', 'dmy') then
    raise exception 'invalid date format' using errcode = '22023';
  end if;
  insert into public.export_history (
    firm_id, requested_by, format, invoice_count, profile, column_keys, include_items, file_name, skipped_count, invoice_ids,
    item_columns, date_format, verified_only
  ) values (
    p_firm_id, p_user_id, p_format, coalesce(cardinality(p_invoice_ids), 0), coalesce(p_profile, 'standard'),
    coalesce(p_column_keys, '{}'), coalesce(p_include_items, false), left(p_file_name, 200), greatest(coalesce(p_skipped, 0), 0),
    coalesce(p_invoice_ids, '{}'), coalesce(p_item_columns, '{}'), p_date_format, coalesce(p_verified_only, false)
  ) returning id into v_id;

  insert into public.usage_records (firm_id, user_id, kind, quantity, outcome)
  values (p_firm_id, p_user_id, 'export', 1, 'ok');

  return v_id;
end $$;

revoke all on function public.record_export(uuid, uuid, text, text, uuid[], int, text[], boolean, text, text[], text, boolean) from public, anon, authenticated;
grant execute on function public.record_export(uuid, uuid, text, text, uuid[], int, text[], boolean, text, text[], text, boolean) to service_role;
