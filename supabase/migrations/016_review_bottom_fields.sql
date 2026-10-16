-- AI Asis: the review screen can now edit the bottom-line fields too (migration 016).
-- Exchange rate, pre-tax charges, TCS, TDS, round-off and net payable were read by the AI but a reviewer could not correct them,
-- so a misread TCS / TDS / rate could only be acknowledged, never fixed. save_invoice_review now writes them.
--
-- Same pattern as utgst_amount (migration 014): a column is written ONLY when the client sent that key, so an older browser tab
-- (which does not send these keys) can never wipe a stored value. A key sent as null clears the value on purpose.
-- exchange_rate stays NULL when blank (never defaulted to 1); the existing check (rate > 0) still applies.
--
-- Run this migration BEFORE deploying the matching app code. The function signature is unchanged.

create or replace function public.save_invoice_review(
  p_firm_id uuid,
  p_invoice_id uuid,
  p_user_id uuid,
  p_expected_updated_at text,
  p_action text,
  p_header jsonb,
  p_field_status jsonb,
  p_corrected jsonb,
  p_items jsonb,
  p_flags jsonb,
  p_new_status text,
  p_changes jsonb,
  p_acknowledged jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv record;
  v_data record;
  v_new_updated timestamptz;
  v_status public.invoice_status;
begin
  if p_action is null or p_action not in ('save', 'verify', 'unverify') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_new_status is null or p_new_status not in ('completed', 'needs_review') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_header is null or jsonb_typeof(p_header) <> 'object'
     or p_field_status is null or jsonb_typeof(p_field_status) <> 'object'
     or p_corrected is null or jsonb_typeof(p_corrected) <> 'object'
     or p_flags is null or jsonb_typeof(p_flags) <> 'array' then
    raise exception 'invalid payload' using errcode = '22023';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid items' using errcode = '22023';
  end if;

  select i.id, i.status into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.firm_id = p_firm_id
     for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_inv.status not in ('completed', 'needs_review', 'verified') then
    return jsonb_build_object('result', 'not_editable');
  end if;

  select e.updated_at into v_data
    from public.extracted_data e
   where e.invoice_id = p_invoice_id and e.firm_id = p_firm_id
     for update;
  if not found then
    return jsonb_build_object('result', 'no_data');
  end if;
  if p_expected_updated_at is null or v_data.updated_at <> p_expected_updated_at::timestamptz then
    return jsonb_build_object('result', 'conflict', 'updated_at', v_data.updated_at);
  end if;

  update public.extracted_data set
    vendor_name = p_header ->> 'vendor_name',
    buyer_name = p_header ->> 'buyer_name',
    vendor_gstin = p_header ->> 'vendor_gstin',
    buyer_gstin = p_header ->> 'buyer_gstin',
    invoice_number = p_header ->> 'invoice_number',
    invoice_number_norm = p_header ->> 'invoice_number_norm',
    invoice_date = (p_header ->> 'invoice_date')::date,
    place_of_supply = p_header ->> 'place_of_supply',
    currency = p_header ->> 'currency',
    document_type = coalesce(p_header ->> 'document_type', document_type),
    taxable_amount = (p_header ->> 'taxable_amount')::numeric,
    discount_amount = (p_header ->> 'discount_amount')::numeric,
    cgst_amount = (p_header ->> 'cgst_amount')::numeric,
    sgst_amount = (p_header ->> 'sgst_amount')::numeric,
    -- Only written when the client sent it, so an older browser tab can never wipe a stored value.
    utgst_amount = case when p_header ? 'utgst_amount' then (p_header ->> 'utgst_amount')::numeric else utgst_amount end,
    igst_amount = (p_header ->> 'igst_amount')::numeric,
    cess_amount = (p_header ->> 'cess_amount')::numeric,
    total_amount = (p_header ->> 'total_amount')::numeric,
    exchange_rate = case when p_header ? 'exchange_rate' then (p_header ->> 'exchange_rate')::numeric else exchange_rate end,
    pre_tax_charges = case when p_header ? 'pre_tax_charges' then (p_header ->> 'pre_tax_charges')::numeric else pre_tax_charges end,
    tcs_amount = case when p_header ? 'tcs_amount' then (p_header ->> 'tcs_amount')::numeric else tcs_amount end,
    tds_amount = case when p_header ? 'tds_amount' then (p_header ->> 'tds_amount')::numeric else tds_amount end,
    round_off_amount = case when p_header ? 'round_off_amount' then (p_header ->> 'round_off_amount')::numeric else round_off_amount end,
    net_payable_amount = case when p_header ? 'net_payable_amount' then (p_header ->> 'net_payable_amount')::numeric else net_payable_amount end,
    field_status = p_field_status,
    corrected_fields = p_corrected,
    review_flags = p_flags,
    items_edited = items_edited or (p_items is not null),
    edited_by = case when p_action = 'unverify' then edited_by else p_user_id end,
    edited_at = case when p_action = 'unverify' then edited_at else now() end,
    verified_by = case when p_action = 'verify' then p_user_id else null end,
    verified_at = case when p_action = 'verify' then now() else null end
  where invoice_id = p_invoice_id and firm_id = p_firm_id
  returning updated_at into v_new_updated;

  if p_items is not null then
    delete from public.line_items where invoice_id = p_invoice_id and firm_id = p_firm_id;
    insert into public.line_items (
      invoice_id, firm_id, "position", description, hsn_code, quantity, unit, unit_price,
      discount_amount, discount_type, applied_tax_type, taxable_amount, gst_rate, gst_amount, line_total, field_status
    )
    select
      p_invoice_id, p_firm_id, t.ord::int,
      t.item ->> 'description', t.item ->> 'hsn_code',
      (t.item ->> 'quantity')::numeric, t.item ->> 'unit', (t.item ->> 'unit_price')::numeric,
      (t.item ->> 'discount_amount')::numeric, t.item ->> 'discount_type', t.item ->> 'applied_tax_type',
      (t.item ->> 'taxable_amount')::numeric,
      (t.item ->> 'gst_rate')::numeric, (t.item ->> 'gst_amount')::numeric,
      (t.item ->> 'line_total')::numeric,
      coalesce(t.item -> 'field_status', '{}'::jsonb)
    from jsonb_array_elements(p_items) with ordinality as t (item, ord);
  end if;

  v_status := case when p_action = 'verify' then 'verified' else p_new_status end::public.invoice_status;
  update public.invoices set status = v_status where id = p_invoice_id and firm_id = p_firm_id;

  insert into public.review_events (firm_id, invoice_id, user_id, action, changes, acknowledged_flags)
  values (
    p_firm_id, p_invoice_id, p_user_id,
    case p_action when 'save' then 'edit' else p_action end,
    coalesce(p_changes, '{}'::jsonb),
    coalesce(p_acknowledged, '[]'::jsonb)
  );

  return jsonb_build_object('result', 'ok', 'updated_at', v_new_updated, 'status', v_status);
end $$;

revoke all on function public.save_invoice_review(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_invoice_review(uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb, jsonb) to service_role;
