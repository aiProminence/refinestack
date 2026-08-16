-- Make workspace deletion an explicit, owner-confirmed, freshly reauthenticated
-- service operation. Browser roles cannot delete workspaces directly, and a
-- durable private tombstone survives the workspace's cascading data removal.

drop policy if exists workspaces_delete_owner on public.workspaces;
revoke delete on public.workspaces from public, anon, authenticated;

create table private.workspace_deletion_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  workspace_name text not null,
  workspace_slug text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  confirmation_kind text not null check (confirmation_kind in ('slug', 'name')),
  reauthentication_method text not null check (reauthentication_method in ('password', 'otp')),
  reauthenticated_at timestamptz not null,
  deleted_at timestamptz not null default clock_timestamp()
);

create index workspace_deletion_events_actor_time_idx
on private.workspace_deletion_events(actor_user_id, deleted_at desc);

revoke all on table private.workspace_deletion_events from public, anon, authenticated;
grant insert, select on table private.workspace_deletion_events to service_role;

create trigger immutable_workspace_deletion_events
before update or delete on private.workspace_deletion_events
for each row execute procedure private.prevent_immutable_mutation();

-- The ordinary membership guard must continue to reject every last-owner
-- removal. It is bypassed only while the service-only deletion RPC is removing
-- the same locked workspace; direct client DELETE is independently revoked.
create or replace function private.protect_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if nullif(current_setting('app.workspace_deletion_id', true), '')
      is distinct from old.workspace_id::text then
      perform 1 from public.workspaces where id = old.workspace_id for update;
      if not exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = old.workspace_id
          and wm.user_id <> old.user_id
          and wm.role = 'owner'
      ) then
        raise exception using errcode = '23514', message = 'A workspace must retain at least one owner.';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.delete_workspace(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_confirmation text,
  p_reauthentication_method text,
  p_reauthenticated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  workspace_row public.workspaces%rowtype;
  actor_role public.workspace_role;
  confirmation_kind text;
  deletion_id uuid := extensions.gen_random_uuid();
  deletion_time timestamptz := clock_timestamp();
  table_row record;
  affected integer;
  blocked integer;
  deleted_in_pass integer;
begin
  if p_workspace_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = 'Workspace deletion identifiers are required.';
  end if;
  if p_reauthentication_method is null
    or p_reauthentication_method not in ('password', 'otp') then
    raise exception using errcode = '28000', message = 'Fresh reauthentication evidence is invalid.';
  end if;
  if p_reauthenticated_at is null
    or p_reauthenticated_at < deletion_time - interval '5 minutes'
    or p_reauthenticated_at > deletion_time + interval '1 minute' then
    raise exception using errcode = '28000', message = 'Fresh reauthentication is required.';
  end if;

  select * into workspace_row
  from public.workspaces
  where id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace was not found.';
  end if;

  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is distinct from 'owner'::public.workspace_role then
    raise exception using errcode = '42501', message = 'Only a current workspace owner can delete this workspace.';
  end if;

  if p_confirmation = workspace_row.slug then
    confirmation_kind := 'slug';
  elsif p_confirmation = workspace_row.name then
    confirmation_kind := 'name';
  else
    raise exception using errcode = '22023', message = 'Workspace confirmation does not match.';
  end if;

  insert into private.workspace_deletion_events (
    id, workspace_id, workspace_name, workspace_slug, actor_user_id,
    confirmation_kind, reauthentication_method, reauthenticated_at, deleted_at
  ) values (
    deletion_id, workspace_row.id, workspace_row.name, workspace_row.slug, p_actor_id,
    confirmation_kind, p_reauthentication_method, p_reauthenticated_at, deletion_time
  );

  perform set_config('app.actor_user_id', p_actor_id::text, true);
  perform set_config('app.workspace_deletion_id', p_workspace_id::text, true);

  -- Tenant tables contain deliberately restrictive immutable-lineage foreign
  -- keys. Delete workspace-scoped rows from leaves upward, retrying blocked
  -- parents until every dependent row is gone. Identifiers come only from the
  -- PostgreSQL catalog and values remain bound parameters.
  loop
    blocked := 0;
    deleted_in_pass := 0;
    for table_row in
      select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname <> 'workspaces'
        and a.attname = 'workspace_id'
        and not a.attisdropped
      order by c.relname
    loop
      begin
        execute format('delete from public.%I where workspace_id = $1', table_row.relname)
          using p_workspace_id;
        get diagnostics affected = row_count;
        deleted_in_pass := deleted_in_pass + affected;
      exception when foreign_key_violation then
        blocked := blocked + 1;
      end;
    end loop;
    exit when blocked = 0;
    if deleted_in_pass = 0 then
      raise exception using errcode = '2BP01', message = 'Workspace dependencies could not be removed safely.';
    end if;
  end loop;

  delete from public.workspaces where id = p_workspace_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Workspace was not found.';
  end if;

  return jsonb_build_object(
    'id', workspace_row.id,
    'name', workspace_row.name,
    'slug', workspace_row.slug,
    'deletion_event_id', deletion_id,
    'deleted_at', deletion_time
  );
end;
$$;

revoke all on function public.delete_workspace(uuid, uuid, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.delete_workspace(uuid, uuid, text, text, timestamptz)
to service_role;
