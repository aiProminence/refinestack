-- Enforce quota, schedule overlap/circuit health, owner retention, and
-- invitation revocation at authoritative database boundaries.

alter table public.runs
  add column schedule_id uuid,
  add column reserved_call_count integer not null default 0
    check (reserved_call_count >= 0),
  add foreign key (schedule_id, project_id, workspace_id)
    references public.schedules(id, project_id, workspace_id) on delete restrict;

-- These records are authoritative snapshots or job requests. Creation is
-- available only through the validating service RPCs, never direct Data API
-- inserts that could bypass hashing, cohort, idempotency or quota checks.
revoke insert on public.runs, public.question_sets, public.question_set_items,
  public.source_versions, public.source_claims from authenticated;
revoke insert, update, delete on public.sources from authenticated;

create index runs_active_schedule_idx
on public.runs(schedule_id, status)
where schedule_id is not null and status in ('queued', 'running');

create or replace function private.protect_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    -- Serialize every owner removal/demotion in a workspace. Without this lock,
    -- two concurrent owners can each observe the other and both commit.
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
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.revoke_workspace_invitation(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_invitation_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.workspace_role;
  invitation_role public.workspace_role;
  revoked_id uuid;
begin
  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null
    or private.workspace_role_rank(actor_role) < private.workspace_role_rank('admin') then
    raise exception using errcode = '42501', message = 'Actor cannot revoke invitations in this workspace.';
  end if;

  select wi.role into invitation_role
  from public.workspace_invitations wi
  where wi.id = p_invitation_id and wi.workspace_id = p_workspace_id
    and wi.accepted_at is null and wi.revoked_at is null and wi.expires_at > now()
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Open invitation was not found.';
  end if;
  if invitation_role = 'owner' and actor_role <> 'owner' then
    raise exception using errcode = '42501', message = 'Only an owner can revoke an owner invitation.';
  end if;

  update public.workspace_invitations
  set revoked_at = now()
  where id = p_invitation_id and workspace_id = p_workspace_id
  returning id into revoked_id;
  return revoked_id;
end;
$$;

revoke all on function public.revoke_workspace_invitation(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.revoke_workspace_invitation(uuid, uuid, uuid)
to service_role;

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
  existing_run record;
  question_row record;
  provider_value public.provider_key;
  actor_role public.workspace_role;
  fingerprint_value text;
  required_calls integer;
  call_limit integer;
  used_calls bigint;
  reserved_calls bigint;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot request runs in this workspace.';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null or char_length(p_idempotency_key) > 200 then
    raise exception using errcode = '22023', message = 'A bounded idempotency key is required.';
  end if;
  if cardinality(p_question_version_ids) is null or cardinality(p_question_version_ids) = 0
    or cardinality(p_providers) is null or cardinality(p_providers) = 0 then
    raise exception using errcode = '22023', message = 'At least one question and provider are required.';
  end if;
  if cardinality(p_question_version_ids) <> (select count(distinct value) from unnest(p_question_version_ids) ids(value))
    or cardinality(p_providers) <> (select count(distinct value) from unnest(p_providers) providers(value)) then
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

  required_calls := cardinality(p_question_version_ids) * cardinality(p_providers);
  select encode(extensions.digest(concat_ws('|', p_workspace_id::text, p_project_id::text,
    (select string_agg(value::text, ',' order by value::text) from unnest(p_question_version_ids) ids(value)),
    (select string_agg(value::text, ',' order by value::text) from unnest(p_providers) providers(value)),
    coalesce(p_estimated_max_cost_usd::text, '')), 'sha256'), 'hex') into fingerprint_value;

  select r.id, r.request_fingerprint into existing_run
  from public.runs r
  where r.workspace_id = p_workspace_id and r.idempotency_key = p_idempotency_key
  for update;
  if found then
    if existing_run.request_fingerprint = fingerprint_value then return existing_run.id; end if;
    raise exception using errcode = '23505', message = 'Idempotency key is already bound to a different run request.';
  end if;

  select q.monthly_call_limit into call_limit
  from public.workspace_quotas q where q.workspace_id = p_workspace_id for update;
  if not found then
    raise exception using errcode = '23514', message = 'Workspace call quota is not configured.';
  end if;
  select coalesce(sum(u.call_count), 0) into used_calls
  from public.usage_events u
  where u.workspace_id = p_workspace_id and u.occurred_at >= date_trunc('month', now());
  select coalesce(sum(r.reserved_call_count), 0) into reserved_calls
  from public.runs r
  where r.workspace_id = p_workspace_id and r.status in ('queued', 'running');
  if used_calls + reserved_calls + required_calls > call_limit then
    raise exception using errcode = '23514',
      message = format('Workspace call quota exceeded by %s call(s).', used_calls + reserved_calls + required_calls - call_limit);
  end if;

  insert into public.runs (
    workspace_id, project_id, status, requested_by, idempotency_key,
    request_fingerprint, requested_capture_count, reserved_call_count, estimated_max_cost_usd
  ) values (
    p_workspace_id, p_project_id, 'queued', p_actor_id, p_idempotency_key,
    fingerprint_value, required_calls, required_calls, p_estimated_max_cost_usd
  ) returning id into run_id_value;

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
      );
    end loop;
  end loop;
  return run_id_value;
end;
$$;

create or replace function private.update_schedule_health_after_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.schedule_id is null
    or new.status not in ('succeeded', 'partial', 'failed', 'cancelled')
    or old.status in ('succeeded', 'partial', 'failed', 'cancelled') then
    return new;
  end if;
  if new.status = 'succeeded' then
    update public.schedules set consecutive_failures = 0, circuit_opened_at = null
    where id = new.schedule_id and workspace_id = new.workspace_id;
  else
    update public.schedules set
      consecutive_failures = consecutive_failures + 1,
      circuit_opened_at = case
        when consecutive_failures + 1 >= failure_threshold then coalesce(circuit_opened_at, now())
        else circuit_opened_at
      end
    where id = new.schedule_id and workspace_id = new.workspace_id;
  end if;
  return new;
end;
$$;

drop trigger if exists update_schedule_health_after_run on public.runs;
create trigger update_schedule_health_after_run
after update of status on public.runs
for each row when (old.status is distinct from new.status)
execute procedure private.update_schedule_health_after_run();

create or replace function public.enqueue_due_schedules(p_now timestamptz default now())
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, extensions
as $$
declare
  schedule_row public.schedules%rowtype;
  run_id_value uuid;
  created_count integer := 0;
  required_calls integer;
  call_limit integer;
  used_calls bigint;
  reserved_calls bigint;
  next_at timestamptz;
begin
  for schedule_row in
    select * from public.schedules s
    where s.enabled and s.circuit_opened_at is null and s.next_run_at <= p_now
      and s.question_set_id is not null
    order by s.next_run_at for update skip locked
  loop
    next_at := case schedule_row.frequency
      when 'daily' then schedule_row.next_run_at + interval '1 day'
      when 'weekly' then schedule_row.next_run_at + interval '1 week'
      when 'monthly' then schedule_row.next_run_at + interval '1 month'
    end;
    if schedule_row.overlap_policy = 'skip' and exists (
      select 1 from public.runs r
      where r.schedule_id = schedule_row.id and r.status in ('queued', 'running')
    ) then
      update public.schedules set next_run_at = next_at where id = schedule_row.id;
      continue;
    end if;

    required_calls := (select count(*) from public.question_set_items qsi
      where qsi.question_set_id = schedule_row.question_set_id) * cardinality(schedule_row.providers);
    select q.monthly_call_limit into call_limit from public.workspace_quotas q
    where q.workspace_id = schedule_row.workspace_id for update;
    select coalesce(sum(u.call_count), 0) into used_calls from public.usage_events u
    where u.workspace_id = schedule_row.workspace_id and u.occurred_at >= date_trunc('month', p_now);
    select coalesce(sum(r.reserved_call_count), 0) into reserved_calls from public.runs r
    where r.workspace_id = schedule_row.workspace_id and r.status in ('queued', 'running');
    if call_limit is null or used_calls + reserved_calls + required_calls > call_limit then
      update public.schedules set
        next_run_at = next_at,
        consecutive_failures = consecutive_failures + 1,
        circuit_opened_at = case when consecutive_failures + 1 >= failure_threshold then p_now else circuit_opened_at end
      where id = schedule_row.id;
      continue;
    end if;

    insert into public.runs (
      workspace_id, project_id, question_set_id, schedule_id, status, requested_by,
      idempotency_key, request_fingerprint, requested_capture_count, reserved_call_count
    ) values (
      schedule_row.workspace_id, schedule_row.project_id, schedule_row.question_set_id,
      schedule_row.id, 'queued', schedule_row.created_by,
      'schedule:' || schedule_row.id::text || ':' || schedule_row.next_run_at::text,
      encode(extensions.digest(schedule_row.id::text || ':' || schedule_row.next_run_at::text, 'sha256'), 'hex'),
      required_calls, required_calls
    ) on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into run_id_value;
    if run_id_value is not null then
      insert into public.run_items (
        workspace_id, project_id, run_id, question_version_id, provider,
        locale, market, idempotency_key
      )
      select schedule_row.workspace_id, schedule_row.project_id, run_id_value,
        qsi.question_version_id, provider_value, qv.locale, qv.market,
        'schedule-item:' || run_id_value::text || ':' || qsi.question_version_id::text || ':' || provider_value::text
      from public.question_set_items qsi
      join public.question_versions qv on qv.id = qsi.question_version_id
        and qv.project_id = schedule_row.project_id and qv.workspace_id = schedule_row.workspace_id
      cross join unnest(schedule_row.providers) provider_list(provider_value)
      where qsi.question_set_id = schedule_row.question_set_id;
      created_count := created_count + 1;
    end if;
    update public.schedules set last_run_at = case when run_id_value is null then last_run_at else p_now end,
      next_run_at = next_at where id = schedule_row.id;
    run_id_value := null;
  end loop;
  return created_count;
end;
$$;

-- Append an audit record in the same transaction as every material product
-- mutation. The trigger intentionally records only operation metadata and
-- changed field names, never row contents or stored credentials.
create or replace function private.audit_material_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  workspace_value uuid;
  entity_value uuid;
  actor_value uuid;
  changed_fields jsonb;
begin
  workspace_value := coalesce((after_row->>'workspace_id')::uuid, (before_row->>'workspace_id')::uuid);
  if workspace_value is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  entity_value := coalesce(
    nullif(after_row->>'id', '')::uuid,
    nullif(before_row->>'id', '')::uuid,
    nullif(after_row->>'user_id', '')::uuid,
    nullif(before_row->>'user_id', '')::uuid
  );
  actor_value := coalesce(
    auth.uid(),
    nullif(after_row->>'created_by', '')::uuid,
    nullif(after_row->>'requested_by', '')::uuid,
    nullif(after_row->>'reviewer_id', '')::uuid,
    nullif(after_row->>'invited_by', '')::uuid,
    nullif(after_row->>'updated_by', '')::uuid
  );
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into changed_fields
    from (
      select key from jsonb_object_keys(after_row) keys(key)
      where before_row->key is distinct from after_row->key
        and key not in ('credential_ciphertext', 'secret_ciphertext', 'token_hash')
    ) changed;
  else
    changed_fields := '[]'::jsonb;
  end if;
  insert into public.audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata
  ) values (
    workspace_value, actor_value, tg_table_name || '.' || lower(tg_op),
    tg_table_name, entity_value,
    jsonb_build_object('operation', lower(tg_op), 'changedFields', changed_fields)
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.audit_material_mutation() from public, anon, authenticated;

do $audit_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'workspace_members', 'workspace_invitations', 'projects', 'brands',
    'questions', 'sources', 'runs', 'classification_reviews', 'actions',
    'schedules', 'provider_connections', 'workspace_quotas', 'api_tokens',
    'webhook_endpoints'
  ]
  loop
    execute format('drop trigger if exists audit_material_mutation on public.%I', table_name);
    execute format(
      'create trigger audit_material_mutation after insert or update or delete on public.%I for each row execute procedure private.audit_material_mutation()',
      table_name
    );
  end loop;
end;
$audit_triggers$;
