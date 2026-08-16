-- A source without its first immutable version is not a valid evidence record.
-- Create both rows in one service-only transaction.

create or replace function public.create_evidence_source(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_kind public.source_kind,
  p_name text,
  p_original_url text,
  p_canonical_url text,
  p_content_text text,
  p_storage_path text,
  p_content_hash text,
  p_mime_type text,
  p_retrieved_at timestamptz,
  p_retrieval_metadata jsonb,
  p_retrieval_allowed boolean,
  p_quoting_allowed boolean,
  p_export_allowed boolean
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_id_value uuid;
  actor_role public.workspace_role;
begin
  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null
    or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot create evidence in this workspace.';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if p_content_text is null and p_storage_path is null then
    raise exception using errcode = '22023', message = 'Evidence content or storage path is required.';
  end if;

  insert into public.sources (
    workspace_id, project_id, kind, name, original_url, canonical_url,
    retrieval_allowed, quoting_allowed, export_allowed, created_by
  ) values (
    p_workspace_id, p_project_id, p_kind, p_name, p_original_url, p_canonical_url,
    p_retrieval_allowed, p_quoting_allowed, p_export_allowed, p_actor_id
  ) returning id into source_id_value;

  insert into public.source_versions (
    workspace_id, project_id, source_id, version, content_text, storage_path,
    content_hash, mime_type, retrieved_at, retrieval_metadata, created_by
  ) values (
    p_workspace_id, p_project_id, source_id_value, 1, p_content_text, p_storage_path,
    p_content_hash, p_mime_type, p_retrieved_at,
    coalesce(p_retrieval_metadata, '{}'::jsonb), p_actor_id
  );
  return source_id_value;
end;
$$;

revoke all on function public.create_evidence_source(
  uuid, uuid, uuid, public.source_kind, text, text, text, text, text, text,
  text, timestamptz, jsonb, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.create_evidence_source(
  uuid, uuid, uuid, public.source_kind, text, text, text, text, text, text,
  text, timestamptz, jsonb, boolean, boolean, boolean
) to service_role;
