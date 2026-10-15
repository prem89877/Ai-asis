-- AI Asis: expose the bottom-line adjustment figures to the review list and exports (migration 015).
--
-- Problem: invoice_review_list (used by the review table, CSV/XLSX exports, Tally and integration sync) carried the printed total but not
-- TCS, TDS, round-off or net payable. An invoice that prints "Subtotal 547,700 / Commercial discount 2,700 / Net payable 545,000"
-- could therefore be exported without the net payable, and TCS / TDS could not be exported at all.
--
-- Additive and non-destructive:
--   * No table, column, row or user edit is changed. The four columns already exist on public.extracted_data (migrations 011 and 012).
--   * The view is replaced with CREATE OR REPLACE VIEW. The existing columns keep their names, types and order; the new ones are
--     appended at the END, which Postgres allows. Existing grants are kept; they are repeated below only so the file is self-contained.
--   * NULL still means "not printed". Nothing is turned into 0.
-- Run this BEFORE deploying the matching app code: the export, Tally and sync routes now select these four columns.
-- Rollback: re-run the view definition from 014_utgst.sql (the extra columns are simply no longer exposed; no data is touched).

create or replace view public.invoice_review_list
with (security_invoker = true) as
select
  i.id,
  i.firm_id,
  i.original_filename,
  i.mime_type,
  i.size_bytes,
  i.status,
  i.created_at,
  i.batch_id,
  e.vendor_name,
  e.vendor_gstin,
  e.buyer_name,
  e.buyer_gstin,
  e.invoice_number,
  e.invoice_date,
  e.place_of_supply,
  e.currency,
  e.document_type,
  e.taxable_amount,
  e.discount_amount,
  e.cgst_amount,
  e.sgst_amount,
  e.utgst_amount,
  e.igst_amount,
  e.cess_amount,
  case
    when e.cgst_amount is null and e.sgst_amount is null and e.utgst_amount is null and e.igst_amount is null and e.cess_amount is null then null
    else coalesce(e.cgst_amount, 0) + coalesce(e.sgst_amount, 0) + coalesce(e.utgst_amount, 0) + coalesce(e.igst_amount, 0) + coalesce(e.cess_amount, 0)
  end as tax_total,
  e.total_amount,
  e.confidence,
  e.review_flags,
  e.verified_at,
  e.edited_at,
  e.updated_at as data_updated_at,
  coalesce(jsonb_array_length(e.review_flags), 0) as flag_count,
  (select count(*) from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f where f ->> 'severity' = 'error') as error_count,
  (select count(*) from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f where f ->> 'severity' = 'warning') as warning_count,
  array(select distinct f ->> 'code' from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f) as flag_codes,
  array(
    select distinct k
    from jsonb_array_elements(coalesce(e.review_flags, '[]'::jsonb)) f,
         lateral unnest(
           case when f ->> 'field' is null then array[f ->> 'code']
                else array[f ->> 'code', (f ->> 'code') || ':' || (f ->> 'field')] end
         ) as k
  ) as flag_keys,
  j.status::text as job_status,
  j.error_code as job_error_code,
  -- appended in 015
  e.tcs_amount,
  e.tds_amount,
  e.round_off_amount,
  e.net_payable_amount
from public.invoices i
left join public.extracted_data e on e.invoice_id = i.id and e.firm_id = i.firm_id
left join lateral (
  select pj.status, pj.error_code
  from public.processing_jobs pj
  where pj.invoice_id = i.id and pj.firm_id = i.firm_id
  order by pj.created_at desc, pj.id desc
  limit 1
) j on true
where i.status <> 'pending_deletion';

revoke all on public.invoice_review_list from anon, authenticated;
grant select on public.invoice_review_list to authenticated;
