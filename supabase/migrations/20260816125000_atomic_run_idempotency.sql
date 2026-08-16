-- Bind every idempotency key to one canonical request fingerprint inside the
-- database, including across concurrent server instances.

alter table public.runs add column request_fingerprint text;

create or replace function public.create_monitoring_run(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_question_version_ids uuid[],
  p_providers public.provider_key[],
  p_idempotency_key text,
  p_estimated_max_cost_usd numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, extensions
as $$
declare
  run_id_value uuid;
  question_row record;
  provider_value public.provider_key;
  actor_role public.workspace_role;
  fingerprint_value text;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot request runs in this workspace.';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null
    or char_length(p_idempotency_key) > 200 then
    raise exception using errcode = '22023', message = 'A bounded idempotency key is required.';
  end if;
  if cardinality(p_question_version_ids) is null or cardinality(p_question_version_ids) = 0
    or cardinality(p_providers) is null or cardinality(p_providers) = 0 then
    raise exception using errcode = '22023', message = 'At least one question and provider are required.';
  end if;
  if cardinality(p_question_version_ids) <> (
    select count(distinct value) from unnest(p_question_version_ids) as ids(value)
  ) or cardinality(p_providers) <> (
    select count(distinct value) from unnest(p_providers) as providers(value)
  ) then
    raise exception using errcode = '22023', message = 'Questions and providers cannot be duplicated.';
  end if;
  if exists (
    select 1 from unnest(p_question_version_ids) id
    where not exists (
      select 1 from public.question_versions qv
      where qv.id = id and qv.project_id = p_project_id and qv.workspace_id = p_workspace_id
    )
  ) then
    raise exception using errcode = '23503', message = 'Question version is outside the requested project.';
  end if;

  select encode(extensions.digest(concat_ws('|',
    p_workspace_id::text,
    p_project_id::text,
    (select string_agg(value::text, ',' order by value::text) from unnest(p_question_version_ids) ids(value)),
    (select string_agg(value::text, ',' order by value::text) from unnest(p_providers) providers(value)),
    coalesce(p_estimated_max_cost_usd::text, '')
  ), 'sha256'), 'hex') into fingerprint_value;

  insert into public.runs (
    workspace_id, project_id, status, requested_by, idempotency_key,
    request_fingerprint, requested_capture_count, estimated_max_cost_usd
  ) values (
    p_workspace_id, p_project_id, 'queued', p_actor_id, p_idempotency_key,
    fingerprint_value, cardinality(p_question_version_ids) * cardinality(p_providers),
    p_estimated_max_cost_usd
  ) on conflict (workspace_id, idempotency_key) where idempotency_key is not null
    do update set idempotency_key = excluded.idempotency_key
    where public.runs.request_fingerprint = excluded.request_fingerprint
  returning id into run_id_value;

  if run_id_value is null then
    raise exception using errcode = '23505', message = 'Idempotency key is already bound to a different run request.';
  end if;

  for question_row in
    select qv.id, qv.locale, qv.market from public.question_versions qv
    where qv.id = any(p_question_version_ids) and qv.project_id = p_project_id
      and qv.workspace_id = p_workspace_id
  loop
    foreach provider_value in array p_providers loop
      insert into public.run_items (
        workspace_id, project_id, run_id, question_version_id, provider,
        locale, market, idempotency_key
      ) values (
        p_workspace_id, p_project_id, run_id_value, question_row.id, provider_value,
        question_row.locale, question_row.market,
        'manual-item:' || run_id_value::text || ':' || question_row.id::text || ':' || provider_value::text
      ) on conflict (workspace_id, idempotency_key) do nothing;
    end loop;
  end loop;
  return run_id_value;
end;
$$;

revoke all on function public.create_monitoring_run(
  uuid, uuid, uuid, uuid[], public.provider_key[], text, numeric
) from public, anon, authenticated;
grant execute on function public.create_monitoring_run(
  uuid, uuid, uuid, uuid[], public.provider_key[], text, numeric
) to service_role;
