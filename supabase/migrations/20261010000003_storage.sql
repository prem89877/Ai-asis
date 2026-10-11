-- AI Asis Phase 2: private invoice bucket. Object path convention: <firm_id>/<invoice_id>.<ext>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 4194304,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Returns the firm id encoded in the first path segment, or null if it is not a UUID.
create or replace function public.storage_path_firm(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return (string_to_array(p_name, '/'))[1]::uuid;
exception when others then
  return null;
end $$;

grant execute on function public.storage_path_firm(text) to authenticated;

-- No UPDATE policy (no overwrites) and nothing for anon.
create policy invoices_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'invoices' and public.is_firm_member(public.storage_path_firm(name)));
create policy invoices_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and public.is_firm_member(public.storage_path_firm(name)));
create policy invoices_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'invoices' and public.is_firm_member(public.storage_path_firm(name)));
