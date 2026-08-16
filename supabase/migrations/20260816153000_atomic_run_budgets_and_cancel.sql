-- Conservative provider budgets reserve the maximum bounded calls/cost for all
-- retries before a run is admitted. Cancellation is authoritative and replay-safe.

create table public.provider_budget_caps (
  provider public.provider_key primary key,
  max_calls_per_capture integer not null check (max_calls_per_capture between 1 and 50),
  max_cost_per_capture_usd numeric(14,6) not null check (max_cost_per_capture_usd > 0),
  rationale text not null,
  updated_at timestamptz not null default now()
);
insert into public.provider_budget_caps (provider, max_calls_per_capture, max_cost_per_capture_usd, rationale) values
  ('openai', 3, 0.150000, 'Three bounded attempts including search and token headroom.'),
  ('claude', 9, 0.750000, 'Three attempts with up to three continuation turns and bounded web searches.'),
  ('google_ai_overview', 6, 0.100000, 'Three attempts with overview and optional detail retrieval.')
on conflict (provider) do update set max_calls_per_capture = excluded.max_calls_per_capture,
  max_cost_per_capture_usd = excluded.max_cost_per_capture_usd,
  rationale = excluded.rationale, updated_at = now();
alter table public.provider_budget_caps enable row level security;
create policy provider_budget_caps_read on public.provider_budget_caps for select to authenticated using (true);
grant select on public.provider_budget_caps to authenticated;
grant all on public.provider_budget_caps to service_role;

alter table public.runs add column reserved_cost_usd numeric(14,6) not null default 0
  check (reserved_cost_usd >= 0);

create or replace function public.create_monitoring_run(
  p_workspace_id uuid, p_project_id uuid, p_actor_id uuid,
  p_question_version_ids uuid[], p_providers public.provider_key[],
  p_idempotency_key text, p_estimated_max_cost_usd numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, extensions
as $$
declare run_id_value uuid; existing_run record; question_row record;
  provider_value public.provider_key; actor_role public.workspace_role;
  fingerprint_value text; capture_count integer; required_calls integer;
  required_cost numeric; cap_count integer; call_limit integer; cost_limit numeric;
  used_calls bigint; used_cost numeric; reserved_calls bigint; reserved_cost numeric;
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
  if exists (select 1 from unnest(p_question_version_ids) id where not exists (
    select 1 from public.question_versions qv where qv.id = id
      and qv.project_id = p_project_id and qv.workspace_id = p_workspace_id)) then
    raise exception using errcode = '23503', message = 'Question version is outside the requested project.';
  end if;
  select count(*), sum(max_calls_per_capture), sum(max_cost_per_capture_usd)
    into cap_count, required_calls, required_cost from public.provider_budget_caps where provider = any(p_providers);
  if cap_count <> cardinality(p_providers) then
    raise exception using errcode = '23514', message = 'A selected provider has no authoritative budget cap.';
  end if;
  capture_count := cardinality(p_question_version_ids) * cardinality(p_providers);
  required_calls := required_calls * cardinality(p_question_version_ids);
  required_cost := required_cost * cardinality(p_question_version_ids);
  select encode(extensions.digest(concat_ws('|', p_workspace_id::text, p_project_id::text,
    (select string_agg(value::text, ',' order by value::text) from unnest(p_question_version_ids) ids(value)),
    (select string_agg(value::text, ',' order by value::text) from unnest(p_providers) providers(value)),
    required_calls::text, required_cost::text), 'sha256'), 'hex') into fingerprint_value;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_idempotency_key, 0));
  select r.id, r.request_fingerprint into existing_run from public.runs r
  where r.workspace_id = p_workspace_id and r.idempotency_key = p_idempotency_key for update;
  if found then
    if existing_run.request_fingerprint = fingerprint_value then return existing_run.id; end if;
    raise exception using errcode = '23505', message = 'Idempotency key is already bound to a different run request.';
  end if;
  select q.monthly_call_limit, q.monthly_cost_limit_usd into call_limit, cost_limit
  from public.workspace_quotas q where q.workspace_id = p_workspace_id for update;
  if not found then raise exception using errcode = '23514', message = 'Workspace quota is not configured.'; end if;
  select coalesce(sum(u.call_count),0), coalesce(sum(u.estimated_cost_usd),0)
    into used_calls, used_cost from public.usage_events u
    where u.workspace_id = p_workspace_id and u.occurred_at >= date_trunc('month', now());
  select coalesce(sum(r.reserved_call_count),0), coalesce(sum(r.reserved_cost_usd),0)
    into reserved_calls, reserved_cost from public.runs r
    where r.workspace_id = p_workspace_id and r.status in ('queued','running');
  if used_calls + reserved_calls + required_calls > call_limit then
    raise exception using errcode = '23514', message = format('Workspace call quota exceeded by %s call(s).', used_calls + reserved_calls + required_calls - call_limit);
  end if;
  if used_cost + reserved_cost + required_cost > cost_limit then
    raise exception using errcode = '23514', message = format('Workspace cost quota exceeded by %s USD.', round(used_cost + reserved_cost + required_cost - cost_limit, 6));
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  insert into public.runs (workspace_id, project_id, status, requested_by, idempotency_key,
    request_fingerprint, requested_capture_count, reserved_call_count, reserved_cost_usd,
    estimated_max_cost_usd)
  values (p_workspace_id, p_project_id, 'queued', p_actor_id, p_idempotency_key,
    fingerprint_value, capture_count, required_calls, required_cost, required_cost)
  returning id into run_id_value;
  for question_row in select qv.id, qv.locale, qv.market from public.question_versions qv
    where qv.id = any(p_question_version_ids) and qv.project_id = p_project_id and qv.workspace_id = p_workspace_id
  loop
    foreach provider_value in array p_providers loop
      insert into public.run_items (workspace_id, project_id, run_id, question_version_id,
        provider, locale, market, idempotency_key)
      values (p_workspace_id, p_project_id, run_id_value, question_row.id, provider_value,
        question_row.locale, question_row.market,
        'manual-item:' || run_id_value::text || ':' || question_row.id::text || ':' || provider_value::text);
    end loop;
  end loop;
  return run_id_value;
end;
$$;

create or replace function public.enqueue_due_schedules(p_now timestamptz default now())
returns integer language plpgsql security invoker set search_path = pg_catalog, extensions
as $$
declare schedule_row public.schedules%rowtype; run_id_value uuid; created_count integer := 0;
  capture_count integer; required_calls integer; required_cost numeric; cap_count integer;
  call_limit integer; cost_limit numeric; used_calls bigint; used_cost numeric;
  reserved_calls bigint; reserved_cost numeric; next_at timestamptz;
begin
  for schedule_row in select * from public.schedules s where s.enabled
    and s.circuit_opened_at is null and s.next_run_at <= p_now and s.question_set_id is not null
    order by s.next_run_at for update skip locked
  loop
    next_at := case schedule_row.frequency when 'daily' then schedule_row.next_run_at + interval '1 day'
      when 'weekly' then schedule_row.next_run_at + interval '1 week'
      when 'monthly' then schedule_row.next_run_at + interval '1 month' end;
    if schedule_row.overlap_policy = 'skip' and exists (select 1 from public.runs r
      where r.schedule_id = schedule_row.id and r.status in ('queued','running')) then
      update public.schedules set next_run_at = next_at where id = schedule_row.id; continue;
    end if;
    capture_count := (select count(*) from public.question_set_items qsi
      where qsi.question_set_id = schedule_row.question_set_id) * cardinality(schedule_row.providers);
    select count(*), sum(max_calls_per_capture), sum(max_cost_per_capture_usd)
      into cap_count, required_calls, required_cost from public.provider_budget_caps
      where provider = any(schedule_row.providers);
    required_calls := required_calls * (capture_count / cardinality(schedule_row.providers));
    required_cost := required_cost * (capture_count / cardinality(schedule_row.providers));
    select q.monthly_call_limit, q.monthly_cost_limit_usd into call_limit, cost_limit
      from public.workspace_quotas q where q.workspace_id = schedule_row.workspace_id for update;
    select coalesce(sum(u.call_count),0), coalesce(sum(u.estimated_cost_usd),0)
      into used_calls, used_cost from public.usage_events u where u.workspace_id = schedule_row.workspace_id
      and u.occurred_at >= date_trunc('month', p_now);
    select coalesce(sum(r.reserved_call_count),0), coalesce(sum(r.reserved_cost_usd),0)
      into reserved_calls, reserved_cost from public.runs r where r.workspace_id = schedule_row.workspace_id
      and r.status in ('queued','running');
    if cap_count <> cardinality(schedule_row.providers) or call_limit is null or cost_limit is null
      or used_calls + reserved_calls + required_calls > call_limit
      or used_cost + reserved_cost + required_cost > cost_limit then
      update public.schedules set next_run_at = next_at, consecutive_failures = consecutive_failures + 1,
        circuit_opened_at = case when consecutive_failures + 1 >= failure_threshold then p_now else circuit_opened_at end
      where id = schedule_row.id; continue;
    end if;
    insert into public.runs (workspace_id, project_id, question_set_id, schedule_id, status,
      requested_by, idempotency_key, request_fingerprint, requested_capture_count,
      reserved_call_count, reserved_cost_usd, estimated_max_cost_usd)
    values (schedule_row.workspace_id, schedule_row.project_id, schedule_row.question_set_id,
      schedule_row.id, 'queued', schedule_row.created_by,
      'schedule:' || schedule_row.id::text || ':' || schedule_row.next_run_at::text,
      encode(extensions.digest(schedule_row.id::text || ':' || schedule_row.next_run_at::text, 'sha256'), 'hex'),
      capture_count, required_calls, required_cost, required_cost)
    on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into run_id_value;
    if run_id_value is not null then
      insert into public.run_items (workspace_id, project_id, run_id, question_version_id,
        provider, locale, market, idempotency_key)
      select schedule_row.workspace_id, schedule_row.project_id, run_id_value,
        qsi.question_version_id, provider_value, qv.locale, qv.market,
        'schedule-item:' || run_id_value::text || ':' || qsi.question_version_id::text || ':' || provider_value::text
      from public.question_set_items qsi join public.question_versions qv on qv.id = qsi.question_version_id
        and qv.project_id = schedule_row.project_id and qv.workspace_id = schedule_row.workspace_id
      cross join unnest(schedule_row.providers) provider_list(provider_value)
      where qsi.question_set_id = schedule_row.question_set_id;
      created_count := created_count + 1;
    end if;
    update public.schedules set last_run_at = case when run_id_value is null then last_run_at else p_now end,
      next_run_at = next_at where id = schedule_row.id; run_id_value := null;
  end loop;
  return created_count;
end;
$$;

create or replace function private.preserve_cancelled_run_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.cancelled_at is not null and new.status <> 'cancelled' then new.status := 'cancelled'; end if;
  return new;
end; $$;
revoke all on function private.preserve_cancelled_run_state() from public, anon, authenticated;
create trigger preserve_cancelled_run_state before update on public.runs
for each row execute procedure private.preserve_cancelled_run_state();

create or replace function private.cancel_requeued_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'queued' and exists (select 1 from public.runs r where r.id = new.run_id and r.cancelled_at is not null) then
    new.status := 'cancelled'; new.completed_at := coalesce(new.completed_at, now());
    new.lease_owner := null; new.lease_expires_at := null;
  end if; return new;
end; $$;
revoke all on function private.cancel_requeued_job() from public, anon, authenticated;
create trigger cancel_requeued_job before update of status on public.run_items
for each row execute procedure private.cancel_requeued_job();

create or replace function public.cancel_monitoring_run(
  p_workspace_id uuid, p_run_id uuid, p_actor_id uuid, p_reason text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare actor_role public.workspace_role; run_row public.runs%rowtype; replayed boolean := false;
begin
  select wm.role into actor_role from public.workspace_members wm where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot cancel runs in this workspace.';
  end if;
  if char_length(trim(coalesce(p_reason,''))) < 3 or char_length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'A cancellation reason between 3 and 500 characters is required.';
  end if;
  select * into run_row from public.runs where id = p_run_id and workspace_id = p_workspace_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Run was not found.'; end if;
  if run_row.status = 'cancelled' then replayed := true;
  elsif run_row.status not in ('queued','running') then
    raise exception using errcode = '55000', message = 'A completed run cannot be cancelled.';
  else
    perform set_config('app.actor_user_id', p_actor_id::text, true);
    update public.runs set status = 'cancelled', cancelled_at = now(), completed_at = now(),
      cancellation_reason = trim(p_reason) where id = p_run_id returning * into run_row;
    update public.run_items set status = 'cancelled', completed_at = now()
    where run_id = p_run_id and status = 'queued';
  end if;
  return jsonb_build_object('id', run_row.id, 'status', 'cancelled',
    'cancelled_at', run_row.cancelled_at, 'cancellation_reason', run_row.cancellation_reason,
    'replayed', replayed);
end; $$;
revoke all on function public.cancel_monitoring_run(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.cancel_monitoring_run(uuid,uuid,uuid,text) to service_role;

create or replace function private.bump_question_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(old.current_prompt,old.question_type,old.persona,old.stage,old.market,old.locale,old.rationale,old.state,old.disqualification_reason)
    is distinct from row(new.current_prompt,new.question_type,new.persona,new.stage,new.market,new.locale,new.rationale,new.state,new.disqualification_reason) then
    new.current_version := old.current_version + 1;
  end if; return new;
end; $$;

create or replace function private.snapshot_question_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare snapshot_hash_value text;
begin
  snapshot_hash_value := encode(extensions.digest(concat_ws('|', new.current_prompt,
    new.question_type::text, new.persona, new.stage, new.market, new.locale,
    new.rationale, new.state::text, new.disqualification_reason), 'sha256'), 'hex');
  insert into public.question_versions (
    workspace_id, project_id, question_id, version, prompt, question_type,
    persona, stage, market, locale, rationale, qualification, snapshot_hash, created_by
  ) values (
    new.workspace_id, new.project_id, new.id, new.current_version, new.current_prompt,
    new.question_type, new.persona, new.stage, new.market, new.locale, new.rationale,
    jsonb_build_object('state', new.state, 'reason', new.disqualification_reason),
    snapshot_hash_value, coalesce((select auth.uid()), new.created_by)
  ) on conflict (question_id, snapshot_hash) do nothing;
  return new;
end;
$$;
revoke all on function private.snapshot_question_version() from public, anon, authenticated;

drop trigger snapshot_question_version on public.questions;
create trigger snapshot_question_version after insert or update of current_prompt, question_type,
  persona, stage, market, locale, rationale, state, disqualification_reason
on public.questions for each row execute procedure private.snapshot_question_version();
