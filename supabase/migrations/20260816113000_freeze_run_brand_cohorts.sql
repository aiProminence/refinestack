-- Freeze the exact project and brand configuration used by every run. This
-- keeps later edits from changing the meaning of historical classifications.

create table public.run_brand_versions (
  workspace_id uuid not null,
  project_id uuid not null,
  run_id uuid not null,
  brand_version_id uuid not null,
  role public.brand_role not null,
  position integer not null check (position > 0),
  created_at timestamptz not null default now(),
  primary key (run_id, brand_version_id),
  foreign key (run_id, project_id, workspace_id)
    references public.runs(id, project_id, workspace_id) on delete cascade,
  foreign key (brand_version_id, project_id, workspace_id)
    references public.brand_versions(id, project_id, workspace_id) on delete restrict,
  unique (run_id, position)
);

create or replace function private.freeze_run_configuration()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.project_version_id is null then
    select pv.id into new.project_version_id
    from public.project_versions pv
    where pv.workspace_id = new.workspace_id and pv.project_id = new.project_id
    order by pv.version desc
    limit 1;
  end if;
  if new.project_version_id is null then
    raise exception using errcode = '23503', message = 'A run requires a frozen project version.';
  end if;
  return new;
end;
$$;

create or replace function private.freeze_run_brand_versions()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.run_brand_versions (
    workspace_id, project_id, run_id, brand_version_id, role, position
  )
  select new.workspace_id, new.project_id, new.id, latest.id, latest.role,
    row_number() over (order by case latest.role when 'primary' then 0 else 1 end, lower(latest.name), latest.id)
  from (
    select distinct on (bv.brand_id) bv.id, bv.role, bv.name, bv.brand_id
    from public.brand_versions bv
    where bv.workspace_id = new.workspace_id and bv.project_id = new.project_id
    order by bv.brand_id, bv.version desc
  ) latest;
  return null;
end;
$$;

revoke all on function private.freeze_run_configuration() from public, anon, authenticated;
revoke all on function private.freeze_run_brand_versions() from public, anon, authenticated;

create trigger freeze_run_configuration
before insert on public.runs
for each row execute procedure private.freeze_run_configuration();

create trigger freeze_run_brand_versions
after insert on public.runs
for each row execute procedure private.freeze_run_brand_versions();

-- The production database is empty at Release 1, but make the migration safe
-- for local fixtures and future restored snapshots.
update public.runs r
set project_version_id = (
  select pv.id from public.project_versions pv
  where pv.workspace_id = r.workspace_id and pv.project_id = r.project_id
  order by pv.version desc limit 1
)
where r.project_version_id is null;

insert into public.run_brand_versions (
  workspace_id, project_id, run_id, brand_version_id, role, position
)
select r.workspace_id, r.project_id, r.id, latest.id, latest.role,
  row_number() over (partition by r.id order by case latest.role when 'primary' then 0 else 1 end, lower(latest.name), latest.id)
from public.runs r
cross join lateral (
  select distinct on (bv.brand_id) bv.id, bv.role, bv.name, bv.brand_id
  from public.brand_versions bv
  where bv.workspace_id = r.workspace_id and bv.project_id = r.project_id
  order by bv.brand_id, bv.version desc
) latest
on conflict (run_id, brand_version_id) do nothing;

alter table public.run_brand_versions enable row level security;

create policy run_brand_versions_select on public.run_brand_versions
for select to authenticated
using (private.is_workspace_member(workspace_id));

grant select on public.run_brand_versions to authenticated;
revoke insert, update, delete on public.run_brand_versions from anon, authenticated;

create trigger immutable_run_brand_versions
before update on public.run_brand_versions
for each row execute procedure private.prevent_immutable_mutation();
