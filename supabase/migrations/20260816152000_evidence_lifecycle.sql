-- Private file evidence, append-only version lifecycle, archive semantics, and
-- citation-to-managed-source lineage for policy-safe exports.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence-private', 'evidence-private', false, 1000000,
  array['text/plain','text/markdown','text/csv','application/json','text/html'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.source_versions
  add column retrieval_allowed boolean not null default true,
  add column quoting_allowed boolean not null default true,
  add column export_allowed boolean not null default true;

update public.source_versions sv set
  retrieval_allowed = s.retrieval_allowed,
  quoting_allowed = s.quoting_allowed,
  export_allowed = s.export_allowed
from public.sources s where s.id = sv.source_id;

drop trigger immutable_source_versions on public.source_versions;
create or replace function private.protect_source_version_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.workspace_id, new.project_id, new.source_id, new.version, new.content_text,
      new.storage_path, new.content_hash, new.mime_type, new.retrieved_at,
      new.valid_from, new.retrieval_metadata, new.retrieval_allowed,
      new.quoting_allowed, new.export_allowed, new.created_by, new.created_at)
    is distinct from
    row(old.workspace_id, old.project_id, old.source_id, old.version, old.content_text,
      old.storage_path, old.content_hash, old.mime_type, old.retrieved_at,
      old.valid_from, old.retrieval_metadata, old.retrieval_allowed,
      old.quoting_allowed, old.export_allowed, old.created_by, old.created_at)
    or old.valid_until is not null or new.valid_until is null then
    raise exception using errcode = '55000', message = 'Source version content and policy are immutable.';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_source_version_immutability() from public, anon, authenticated;
create trigger immutable_source_versions before update on public.source_versions
for each row execute procedure private.protect_source_version_immutability();

create or replace function public.create_evidence_source(
  p_workspace_id uuid, p_project_id uuid, p_actor_id uuid, p_kind public.source_kind,
  p_name text, p_original_url text, p_canonical_url text, p_content_text text,
  p_storage_path text, p_content_hash text, p_mime_type text, p_retrieved_at timestamptz,
  p_retrieval_metadata jsonb, p_retrieval_allowed boolean, p_quoting_allowed boolean,
  p_export_allowed boolean
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare source_id_value uuid; actor_role public.workspace_role;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot create evidence in this workspace.';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if p_content_text is null and p_storage_path is null then
    raise exception using errcode = '22023', message = 'Evidence content or storage path is required.';
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  insert into public.sources (workspace_id, project_id, kind, name, original_url, canonical_url,
    retrieval_allowed, quoting_allowed, export_allowed, created_by)
  values (p_workspace_id, p_project_id, p_kind, trim(p_name), p_original_url, p_canonical_url,
    p_retrieval_allowed, p_quoting_allowed, p_export_allowed, p_actor_id)
  returning id into source_id_value;
  insert into public.source_versions (workspace_id, project_id, source_id, version, content_text,
    storage_path, content_hash, mime_type, retrieved_at, retrieval_metadata,
    retrieval_allowed, quoting_allowed, export_allowed, created_by)
  values (p_workspace_id, p_project_id, source_id_value, 1, p_content_text, p_storage_path,
    p_content_hash, p_mime_type, p_retrieved_at, coalesce(p_retrieval_metadata, '{}'::jsonb),
    p_retrieval_allowed, p_quoting_allowed, p_export_allowed, p_actor_id);
  return source_id_value;
end;
$$;

create or replace function public.append_evidence_source_version(
  p_workspace_id uuid, p_project_id uuid, p_source_id uuid, p_actor_id uuid,
  p_content_text text, p_storage_path text, p_content_hash text, p_mime_type text,
  p_retrieved_at timestamptz, p_retrieval_metadata jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare source_row public.sources%rowtype; actor_role public.workspace_role;
  next_version integer; version_id uuid;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot version evidence in this workspace.';
  end if;
  select * into source_row from public.sources s where s.id = p_source_id
    and s.workspace_id = p_workspace_id and s.project_id = p_project_id for update;
  if not found then raise exception using errcode = '23503', message = 'Evidence source was not found.'; end if;
  if source_row.state <> 'active' then raise exception using errcode = '55000', message = 'Archived evidence cannot receive a new version.'; end if;
  if p_content_text is null and p_storage_path is null then
    raise exception using errcode = '22023', message = 'Evidence content or storage path is required.';
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  select coalesce(max(version), 0) + 1 into next_version from public.source_versions
  where source_id = p_source_id;
  update public.source_versions set valid_until = now()
  where source_id = p_source_id and valid_until is null;
  insert into public.source_versions (workspace_id, project_id, source_id, version, content_text,
    storage_path, content_hash, mime_type, retrieved_at, retrieval_metadata,
    retrieval_allowed, quoting_allowed, export_allowed, created_by)
  values (p_workspace_id, p_project_id, p_source_id, next_version, p_content_text, p_storage_path,
    p_content_hash, p_mime_type, p_retrieved_at, coalesce(p_retrieval_metadata, '{}'::jsonb),
    source_row.retrieval_allowed, source_row.quoting_allowed, source_row.export_allowed, p_actor_id)
  returning id into version_id;
  update public.sources set updated_at = now() where id = p_source_id;
  return version_id;
end;
$$;

create or replace function public.archive_evidence_source(
  p_workspace_id uuid, p_project_id uuid, p_source_id uuid, p_actor_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare actor_role public.workspace_role; archived_id uuid;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot archive evidence in this workspace.';
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  update public.sources set state = 'archived', updated_at = now()
  where id = p_source_id and workspace_id = p_workspace_id and project_id = p_project_id
  returning id into archived_id;
  if archived_id is null then raise exception using errcode = '23503', message = 'Evidence source was not found.'; end if;
  return archived_id;
end;
$$;

revoke all on function public.append_evidence_source_version(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb)
from public, anon, authenticated;
grant execute on function public.append_evidence_source_version(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb)
to service_role;
revoke all on function public.archive_evidence_source(uuid,uuid,uuid,uuid)
from public, anon, authenticated;
grant execute on function public.archive_evidence_source(uuid,uuid,uuid,uuid)
to service_role;

alter table public.citations add column source_version_id uuid;
alter table public.citations add constraint citations_source_version_project_workspace_fkey
foreign key (source_version_id, project_id, workspace_id)
references public.source_versions(id, project_id, workspace_id) on delete restrict;
create index citations_source_version_project_workspace_idx
on public.citations(source_version_id, project_id, workspace_id);

create or replace function private.link_citation_source_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_version_id is null then
    select sv.id into new.source_version_id
    from public.sources s join public.source_versions sv on sv.source_id = s.id
    where s.workspace_id = new.workspace_id and s.project_id = new.project_id
      and s.state = 'active' and (s.canonical_url = new.canonical_url or s.original_url = new.original_url)
      and sv.valid_until is null
    order by sv.version desc limit 1;
  end if;
  return new;
end;
$$;
revoke all on function private.link_citation_source_version() from public, anon, authenticated;
create trigger link_citation_source_version before insert on public.citations
for each row execute procedure private.link_citation_source_version();

