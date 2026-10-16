-- AI Asis: expose pre_tax_charges (freight / packing printed before tax) to the review list and exports (migration 019).
--
-- Why: the Tally export needs it. An invoice whose freight is kept outside the taxable value only balances if the freight is booked
-- to its own ledger; without the column such an invoice was skipped as "does not add up".
--
-- Additive and non-destructive: same CREATE OR REPLACE VIEW as 015; the existing columns keep their names, types and order and the
-- new one is appended at the END. NULL still means "not printed". Nothing is turned into 0.
-- Run this BEFORE deploying the matching app code: export, Tally and sync now select pre_tax_charges.
-- Rollback: re-run the view definition from 015_export_adjustments.sql.

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
  e.net_payable_amount,
  -- appended in 019
  e.pre_tax_charges
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

-- Duplicate detection: invoice numbers are now normalized with separators kept as ONE "-" ("INV/001" -> "INV-001", "12/3" -> "12-3"),
-- no longer with all punctuation removed ("12/3" and "1/23" both became "123" and were reported as duplicates).
-- Re-computes the stored value for existing rows so old and new uploads compare equal. Same rule as lib/extraction/invoice-number.ts.
-- The updated_at trigger is switched off for this one statement so the review screen does not treat every row as "edited just now".
alter table public.extracted_data disable trigger extracted_data_updated_at;
update public.extracted_data
   set invoice_number_norm = nullif(trim(both '-' from regexp_replace(upper(invoice_number), '[^A-Z0-9]+', '-', 'g')), '')
 where invoice_number is not null
   and invoice_number_norm is distinct from nullif(trim(both '-' from regexp_replace(upper(invoice_number), '[^A-Z0-9]+', '-', 'g')), '');
alter table public.extracted_data enable trigger extracted_data_updated_at;
