-- An expired provider lease is an ambiguous external side effect: the worker
-- may have reached the provider before it disappeared. Persist one immutable
-- attempt and one idempotent usage event before requeueing so billing is never
-- silently omitted or counted twice by repeated recovery cycles.

alter table public.run_items
  add column if not exists lease_started_at timestamptz;

create or replace function private.normalize_run_item_lease_started_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'leased' then
    new.lease_started_at := null;
  elsif old.status is distinct from 'leased' and new.lease_started_at is null then
    new.lease_started_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.normalize_run_item_lease_started_at()
from public, anon, authenticated;

drop trigger if exists normalize_run_item_lease_started_at on public.run_items;
create trigger normalize_run_item_lease_started_at
before update of status, lease_started_at on public.run_items
for each row execute procedure private.normalize_run_item_lease_started_at();

create or replace function public.lease_capture_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns setof public.run_items
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(trim(p_worker_id), '') is null or p_limit not between 1 and 100
    or p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid lease request.';
  end if;

  return query
  with candidates as (
    select ri.id
    from public.run_items ri
    join public.runs r on r.id = ri.run_id
      and r.project_id = ri.project_id and r.workspace_id = ri.workspace_id
    where ri.status = 'queued'
      and ri.available_at <= now()
      and ri.attempt_count < ri.max_attempts
      and r.cancelled_at is null
    order by ri.available_at, ri.created_at
    for update of ri skip locked
    limit p_limit
  ), leased as (
    update public.run_items ri
    set status = 'leased',
        lease_owner = trim(p_worker_id),
        lease_started_at = now(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = ri.attempt_count + 1,
        started_at = coalesce(ri.started_at, now())
    from candidates c
    where ri.id = c.id
    returning ri.*
  )
  select * from leased;

  update public.runs r
  set status = 'running', started_at = coalesce(r.started_at, now())
  where r.id in (
    select ri.run_id
    from public.run_items ri
    where ri.lease_owner = trim(p_worker_id) and ri.status = 'leased'
  ) and r.status = 'queued';
end;
$$;

create or replace function public.recover_expired_capture_leases(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job record;
  attempt_id_value uuid;
  next_status public.job_status;
  recovered integer := 0;
  affected_run_ids uuid[] := '{}'::uuid[];
  requested_at_value timestamptz;
  latency_ms_value integer;
begin
  if p_now is null then
    raise exception using errcode = '22023', message = 'Recovery time is required.';
  end if;

  for job in
    select ri.*, qv.prompt as exact_prompt
    from public.run_items ri
    join public.question_versions qv on qv.id = ri.question_version_id
      and qv.project_id = ri.project_id and qv.workspace_id = ri.workspace_id
    where ri.status = 'leased' and ri.lease_expires_at < p_now
    order by ri.lease_expires_at, ri.id
    for update of ri skip locked
  loop
    requested_at_value := coalesce(job.lease_started_at, least(job.lease_expires_at, p_now));
    latency_ms_value := greatest(
      0,
      floor(extract(epoch from (p_now - requested_at_value)) * 1000)
    )::integer;
    next_status := case
      when job.attempt_count < job.max_attempts then 'queued'::public.job_status
      else 'failed'::public.job_status
    end;
    attempt_id_value := null;

    insert into public.capture_attempts (
      workspace_id, project_id, run_item_id, attempt_number, status,
      access_method, model_or_surface, exact_prompt, requested_at, captured_at,
      latency_ms, call_count, search_requests, input_tokens, output_tokens,
      estimated_cost_usd, usage_complete, billing_ambiguous, raw_response,
      error_code, error_message, retryable
    ) values (
      job.workspace_id, job.project_id, job.id, job.attempt_count, 'failed',
      case when job.provider = 'google_ai_overview' then 'search_api' else 'api' end,
      'unknown (expired worker lease)', job.exact_prompt,
      requested_at_value, p_now, latency_ms_value,
      1, null, null, null, null, false, true,
      jsonb_build_object(
        'kind', 'expired_worker_lease',
        'leaseOwner', job.lease_owner,
        'leaseStartedAt', job.lease_started_at,
        'leaseExpiresAt', job.lease_expires_at,
        'recoveredAt', p_now,
        'billingState', 'ambiguous'
      ),
      'lease_expired',
      'Worker lease expired before a provider outcome could be finalized.',
      next_status = 'queued'
    )
    on conflict (run_item_id, attempt_number) do nothing
    returning id into attempt_id_value;

    if attempt_id_value is not null then
      insert into public.usage_events (
        workspace_id, project_id, run_id, run_item_id, capture_attempt_id,
        provider, call_count, search_requests, input_tokens, output_tokens,
        estimated_cost_usd, usage_complete, billing_ambiguous, idempotency_key,
        occurred_at
      ) values (
        job.workspace_id, job.project_id, job.run_id, job.id, attempt_id_value,
        job.provider, 1, null, 0, 0, 0, false, true,
        'lease-expired:' || job.id::text || ':' || job.attempt_count::text,
        p_now
      )
      on conflict (workspace_id, idempotency_key) do nothing;
    end if;

    update public.run_items
    set status = next_status,
        lease_owner = null,
        lease_expires_at = null,
        available_at = p_now,
        last_error_code = 'lease_expired',
        completed_at = case when next_status = 'failed' then p_now else completed_at end
    where id = job.id;

    recovered := recovered + 1;
    if not job.run_id = any(affected_run_ids) then
      affected_run_ids := array_append(affected_run_ids, job.run_id);
    end if;
  end loop;

  update public.runs r
  set status = case
      when exists (
        select 1 from public.run_items x
        where x.run_id = r.id and x.status in ('queued', 'leased')
      ) then r.status
      when exists (
        select 1 from public.run_items x
        where x.run_id = r.id and x.status = 'succeeded'
      ) and exists (
        select 1 from public.run_items x
        where x.run_id = r.id and x.status in ('failed', 'unavailable', 'cancelled')
      ) then 'partial'::public.run_status
      when exists (
        select 1 from public.run_items x
        where x.run_id = r.id and x.status = 'succeeded'
      ) then 'succeeded'::public.run_status
      else 'failed'::public.run_status
    end,
    completed_at = case when not exists (
      select 1 from public.run_items x
      where x.run_id = r.id and x.status in ('queued', 'leased')
    ) then p_now else r.completed_at end
  where r.id = any(affected_run_ids);

  return recovered;
end;
$$;

revoke all on function public.lease_capture_jobs(text, integer, integer)
from public, anon, authenticated;
revoke all on function public.recover_expired_capture_leases(timestamptz)
from public, anon, authenticated;
grant execute on function public.lease_capture_jobs(text, integer, integer)
to service_role;
grant execute on function public.recover_expired_capture_leases(timestamptz)
to service_role;
