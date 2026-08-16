-- Preserve the configured wall-clock schedule across DST and month length,
-- validate IANA zones authoritatively, and expose an audited circuit reset.

alter table public.schedules drop constraint if exists schedules_month_day_check;
alter table public.schedules add constraint schedules_month_day_check
  check (month_day between 1 and 31);

create or replace function private.validate_schedule_calendar()
returns trigger
language plpgsql
set search_path = ''
as $$
declare local_anchor timestamp;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception using errcode = '22023', message = 'Schedule timezone is not a recognized IANA zone.';
  end if;
  if new.enabled and new.next_run_at is null then
    raise exception using errcode = '22023', message = 'An enabled schedule requires its first run.';
  end if;
  if new.next_run_at is not null then
    local_anchor := new.next_run_at at time zone new.timezone;
    if new.frequency = 'weekly' then
      new.weekday := coalesce(new.weekday, extract(dow from local_anchor)::smallint);
    elsif new.frequency = 'monthly' then
      new.month_day := coalesce(new.month_day, extract(day from local_anchor)::smallint);
    end if;
  end if;
  if new.frequency = 'weekly' and new.weekday is null then
    raise exception using errcode = '22023', message = 'A weekly schedule requires a local weekday.';
  end if;
  if new.frequency = 'monthly' and new.month_day is null then
    raise exception using errcode = '22023', message = 'A monthly schedule requires a local month day.';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_schedule_calendar() from public, anon, authenticated;
create trigger validate_schedule_calendar
before insert or update of frequency, timezone, local_time, weekday, month_day, enabled, next_run_at
on public.schedules for each row execute procedure private.validate_schedule_calendar();

create or replace function private.next_schedule_occurrence(
  p_timezone text,
  p_local_time time,
  p_frequency public.schedule_frequency,
  p_weekday smallint,
  p_month_day smallint,
  p_after timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare local_after timestamp; target_date date; month_start date; month_end date;
  delta_days integer;
begin
  if p_after is null or p_local_time is null
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    raise exception using errcode = '22023', message = 'Schedule recurrence configuration is invalid.';
  end if;
  local_after := p_after at time zone p_timezone;
  if p_frequency = 'daily' then
    target_date := local_after::date + 1;
  elsif p_frequency = 'weekly' then
    if p_weekday is null or p_weekday not between 0 and 6 then
      raise exception using errcode = '22023', message = 'Weekly recurrence weekday is invalid.';
    end if;
    delta_days := (p_weekday - extract(dow from local_after)::integer + 7) % 7;
    if delta_days = 0 then delta_days := 7; end if;
    target_date := local_after::date + delta_days;
  else
    if p_month_day is null or p_month_day not between 1 and 31 then
      raise exception using errcode = '22023', message = 'Monthly recurrence day is invalid.';
    end if;
    month_start := (date_trunc('month', local_after) + interval '1 month')::date;
    month_end := (month_start + interval '1 month - 1 day')::date;
    target_date := month_start + least(p_month_day, extract(day from month_end)::integer) - 1;
  end if;
  return (target_date + p_local_time) at time zone p_timezone;
end;
$$;
revoke all on function private.next_schedule_occurrence(text,time,public.schedule_frequency,smallint,smallint,timestamptz)
from public, anon, authenticated;

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
    next_at := private.next_schedule_occurrence(schedule_row.timezone, schedule_row.local_time,
      schedule_row.frequency, schedule_row.weekday, schedule_row.month_day, schedule_row.next_run_at);
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

create or replace function public.reset_schedule_circuit(
  p_workspace_id uuid, p_project_id uuid, p_schedule_id uuid, p_actor_id uuid
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare actor_role public.workspace_role; schedule_row public.schedules%rowtype;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('admin') then
    raise exception using errcode = '42501', message = 'Actor cannot reset schedule circuits.';
  end if;
  select * into schedule_row from public.schedules s where s.id = p_schedule_id
    and s.workspace_id = p_workspace_id and s.project_id = p_project_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Schedule was not found.'; end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  update public.schedules set consecutive_failures = 0, circuit_opened_at = null,
    enabled = true,
    next_run_at = case when next_run_at is null or next_run_at <= now()
      then private.next_schedule_occurrence(timezone, local_time, frequency, weekday, month_day, now())
      else next_run_at end
  where id = p_schedule_id;
  return p_schedule_id;
end;
$$;
revoke all on function public.reset_schedule_circuit(uuid,uuid,uuid,uuid)
from public, anon, authenticated;
grant execute on function public.reset_schedule_circuit(uuid,uuid,uuid,uuid) to service_role;
