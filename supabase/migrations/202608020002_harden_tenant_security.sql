create schema if not exists private;

create or replace function private.is_workspace_member(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = (select auth.uid())
  );
$$;

create or replace function private.can_edit_workspace(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = (select auth.uid())
      and role in ('owner', 'admin', 'analyst')
  );
$$;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  workspace_id uuid;
  workspace_name text;
begin
  workspace_name := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1), 'My') || '''s workspace';
  insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data ->> 'full_name');
  insert into public.workspaces (name, slug, created_by)
    values (workspace_name, 'workspace-' || substr(replace(new.id::text, '-', ''), 1, 12), new.id)
    returning id into workspace_id;
  insert into public.workspace_members (workspace_id, user_id, role) values (workspace_id, new.id, 'owner');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure private.handle_new_user();

drop policy "profiles are self readable" on public.profiles;
create policy "profiles are self readable" on public.profiles for select
using (id = (select auth.uid()));

drop policy "profiles are self editable" on public.profiles;
create policy "profiles are self editable" on public.profiles for update
using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy "members can read workspaces" on public.workspaces;
create policy "members can read workspaces" on public.workspaces for select
using (private.is_workspace_member(id));

drop policy "members can read memberships" on public.workspace_members;
create policy "members can read memberships" on public.workspace_members for select
using (private.is_workspace_member(workspace_id));

drop policy "members can read brands" on public.brands;
create policy "members can read brands" on public.brands for select
using (private.is_workspace_member(workspace_id));

drop policy "editors can create brands" on public.brands;
create policy "editors can create brands" on public.brands for insert
with check (private.can_edit_workspace(workspace_id));

drop policy "editors can update brands" on public.brands;
create policy "editors can update brands" on public.brands for update
using (private.can_edit_workspace(workspace_id)) with check (private.can_edit_workspace(workspace_id));

drop policy "editors can delete brands" on public.brands;
create policy "editors can delete brands" on public.brands for delete
using (private.can_edit_workspace(workspace_id));

drop policy "members can read decisions" on public.buyer_decisions;
create policy "members can read decisions" on public.buyer_decisions for select
using (private.is_workspace_member(workspace_id));

drop policy "editors can create decisions" on public.buyer_decisions;
create policy "editors can create decisions" on public.buyer_decisions for insert
with check (private.can_edit_workspace(workspace_id) and created_by = (select auth.uid()));

drop policy "editors can update decisions" on public.buyer_decisions;
create policy "editors can update decisions" on public.buyer_decisions for update
using (private.can_edit_workspace(workspace_id)) with check (private.can_edit_workspace(workspace_id));

drop policy "editors can delete decisions" on public.buyer_decisions;
create policy "editors can delete decisions" on public.buyer_decisions for delete
using (private.can_edit_workspace(workspace_id));

drop policy "members can read runs" on public.monitoring_runs;
create policy "members can read runs" on public.monitoring_runs for select
using (private.is_workspace_member(workspace_id));

drop policy "editors can request runs" on public.monitoring_runs;
create policy "editors can request runs" on public.monitoring_runs for insert
with check (private.can_edit_workspace(workspace_id) and requested_by = (select auth.uid()) and status = 'pending');

drop policy "members can read observations" on public.observations;
create policy "members can read observations" on public.observations for select
using (private.is_workspace_member(workspace_id));

drop policy "members can read citations" on public.citations;
create policy "members can read citations" on public.citations for select using (
  exists (select 1 from public.observations o where o.id = observation_id and private.is_workspace_member(o.workspace_id))
);

drop policy "members can read brand events" on public.brand_events;
create policy "members can read brand events" on public.brand_events for select using (
  exists (select 1 from public.observations o where o.id = observation_id and private.is_workspace_member(o.workspace_id))
);

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.can_edit_workspace(uuid) to authenticated;

drop function public.handle_new_user();
drop function public.is_workspace_member(uuid);
drop function public.can_edit_workspace(uuid);

create index brand_events_brand_idx on public.brand_events(brand_id);
create index buyer_decisions_workspace_idx on public.buyer_decisions(workspace_id);
create index buyer_decisions_created_by_idx on public.buyer_decisions(created_by);
create index monitoring_runs_workspace_idx on public.monitoring_runs(workspace_id);
create index monitoring_runs_requested_by_idx on public.monitoring_runs(requested_by);
create index observations_buyer_decision_idx on public.observations(buyer_decision_id);
create index workspaces_created_by_idx on public.workspaces(created_by);
