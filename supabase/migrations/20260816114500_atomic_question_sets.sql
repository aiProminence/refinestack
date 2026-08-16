-- Create immutable question cohorts atomically. The RPC is service-only and
-- validates the mailbox-authenticated actor supplied by the server action.

create or replace function public.create_question_set(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_name text,
  p_question_version_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  question_set_id_value uuid;
  next_version integer;
  cohort_hash_value text;
  actor_role public.workspace_role;
begin
  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null
    or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot create question sets in this workspace.';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'Question set name is required.';
  end if;
  if coalesce(cardinality(p_question_version_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'At least one question version is required.';
  end if;
  if cardinality(p_question_version_ids) <> (
    select count(distinct value) from unnest(p_question_version_ids) as ids(value)
  ) then
    raise exception using errcode = '22023', message = 'Question versions cannot be duplicated.';
  end if;

  perform 1 from public.projects p
  where p.id = p_project_id and p.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if exists (
    select 1 from unnest(p_question_version_ids) as ids(value)
    where not exists (
      select 1 from public.question_versions qv
      where qv.id = ids.value and qv.project_id = p_project_id
        and qv.workspace_id = p_workspace_id
    )
  ) then
    raise exception using errcode = '23503', message = 'Question version is outside the requested project.';
  end if;

  select coalesce(max(qs.version), 0) + 1 into next_version
  from public.question_sets qs
  where qs.project_id = p_project_id and qs.workspace_id = p_workspace_id
    and qs.name = trim(p_name);
  select encode(digest(string_agg(ids.value::text, '|' order by ids.value::text), 'sha256'), 'hex')
  into cohort_hash_value
  from unnest(p_question_version_ids) as ids(value);

  insert into public.question_sets (
    workspace_id, project_id, name, version, cohort_hash, created_by
  ) values (
    p_workspace_id, p_project_id, trim(p_name), next_version,
    cohort_hash_value, p_actor_id
  ) returning id into question_set_id_value;

  insert into public.question_set_items (
    workspace_id, project_id, question_set_id, question_version_id, position
  )
  select p_workspace_id, p_project_id, question_set_id_value, item.value, item.ordinality::integer
  from unnest(p_question_version_ids) with ordinality as item(value, ordinality);

  return question_set_id_value;
end;
$$;

revoke all on function public.create_question_set(uuid, uuid, uuid, text, uuid[])
from public, anon, authenticated;
grant execute on function public.create_question_set(uuid, uuid, uuid, text, uuid[])
to service_role;
