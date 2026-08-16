-- Resolve material performance-advisor findings after the Release 1 schema.
drop policy if exists "members can read citations" on public.citations;
drop policy if exists "members can read observations" on public.observations;

drop policy if exists provider_connections_write on public.provider_connections;
create policy provider_connections_insert on public.provider_connections
for insert to authenticated
with check (private.has_workspace_role(workspace_id, 'admin'));
create policy provider_connections_update on public.provider_connections
for update to authenticated
using (private.has_workspace_role(workspace_id, 'admin'))
with check (private.has_workspace_role(workspace_id, 'admin'));
create policy provider_connections_delete on public.provider_connections
for delete to authenticated
using (private.has_workspace_role(workspace_id, 'admin'));

alter table public.workspaces drop constraint if exists workspaces_id_workspace_unique;
