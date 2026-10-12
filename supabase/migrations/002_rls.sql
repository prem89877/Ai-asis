-- AI Asis Phase 2: Row Level Security. Default deny; policies only grant what is needed.

-- Helpers are SECURITY DEFINER so policies can check membership without recursive RLS.
create or replace function public.is_firm_member(p_firm uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.firm_members m
    where m.firm_id = p_firm and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_firm_role(p_firm uuid, p_roles public.firm_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.firm_members m
    where m.firm_id = p_firm and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

revoke all on function public.is_firm_member(uuid) from public, anon;
revoke all on function public.has_firm_role(uuid, public.firm_role[]) from public, anon;
grant execute on function public.is_firm_member(uuid) to authenticated;
grant execute on function public.has_firm_role(uuid, public.firm_role[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.firms enable row level security;
alter table public.firm_members enable row level security;
alter table public.clients enable row level security;
alter table public.invoices enable row level security;
alter table public.extracted_data enable row level security;
alter table public.line_items enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.usage_records enable row level security;
alter table public.export_history enable row level security;

-- Table privileges: nothing for anon, minimal for authenticated.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select on public.firms to authenticated;
grant update (name) on public.firms to authenticated;
grant select, delete on public.firm_members to authenticated;
grant select, insert, delete on public.clients to authenticated;
grant update (name, gstin, email, notes) on public.clients to authenticated;
grant select, insert, delete on public.invoices to authenticated;
grant update (client_id, original_filename, status, deletion_requested_at) on public.invoices to authenticated;
grant select, insert, update, delete on public.extracted_data to authenticated;
grant select, insert, update, delete on public.line_items to authenticated;
grant select on public.processing_jobs to authenticated;
grant select on public.usage_records to authenticated;
grant select, insert on public.export_history to authenticated;

-- profiles: own row only
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- firms: members read; owners/admins rename. Creation happens only via the signup trigger.
create policy firms_select_member on public.firms for select to authenticated
  using (public.is_firm_member(id));
create policy firms_update_admin on public.firms for update to authenticated
  using (public.has_firm_role(id, array['owner', 'admin']::public.firm_role[]))
  with check (public.has_firm_role(id, array['owner', 'admin']::public.firm_role[]));

-- firm_members: members see colleagues; a non-owner may leave. No client-side inserts:
-- invitations will be added later through a server-side flow.
create policy firm_members_select on public.firm_members for select to authenticated
  using (public.is_firm_member(firm_id));
create policy firm_members_leave on public.firm_members for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'owner');

-- clients
create policy clients_select on public.clients for select to authenticated
  using (public.is_firm_member(firm_id));
create policy clients_insert on public.clients for insert to authenticated
  with check (public.is_firm_member(firm_id));
create policy clients_update on public.clients for update to authenticated
  using (public.is_firm_member(firm_id)) with check (public.is_firm_member(firm_id));
create policy clients_delete on public.clients for delete to authenticated
  using (public.has_firm_role(firm_id, array['owner', 'admin']::public.firm_role[]));

-- invoices
create policy invoices_select on public.invoices for select to authenticated
  using (public.is_firm_member(firm_id));
create policy invoices_insert on public.invoices for insert to authenticated
  with check (
    public.is_firm_member(firm_id)
    and uploaded_by = (select auth.uid())
    and status = 'uploaded'
    and deletion_requested_at is null
  );
create policy invoices_update on public.invoices for update to authenticated
  using (public.is_firm_member(firm_id)) with check (public.is_firm_member(firm_id));
create policy invoices_delete on public.invoices for delete to authenticated
  using (
    public.is_firm_member(firm_id)
    and (uploaded_by = (select auth.uid())
         or public.has_firm_role(firm_id, array['owner', 'admin']::public.firm_role[]))
  );

-- extracted_data and line_items (written by server-side extraction in a later phase)
create policy extracted_data_all on public.extracted_data for all to authenticated
  using (public.is_firm_member(firm_id)) with check (public.is_firm_member(firm_id));
create policy line_items_all on public.line_items for all to authenticated
  using (public.is_firm_member(firm_id)) with check (public.is_firm_member(firm_id));

-- read-only for clients; written by trusted server code only
create policy processing_jobs_select on public.processing_jobs for select to authenticated
  using (public.is_firm_member(firm_id));
create policy usage_records_select on public.usage_records for select to authenticated
  using (public.is_firm_member(firm_id));

-- export history
create policy export_history_select on public.export_history for select to authenticated
  using (public.is_firm_member(firm_id));
create policy export_history_insert on public.export_history for insert to authenticated
  with check (public.is_firm_member(firm_id) and requested_by = (select auth.uid()));
