-- Durable worker hydration and atomic attempt finalization. The v2 RPCs keep
-- the already-applied Release 1 signatures available while closing usage and
-- frozen-cohort integrity gaps for the production worker.

alter table public.capture_attempts
  add column if not exists call_count integer not null default 0 check (call_count >= 0),
  add column if not exists search_requests integer check (search_requests is null or search_requests >= 0),
  add column if not exists usage_complete boolean not null default false,
  add column if not exists billing_ambiguous boolean not null default false;

alter table public.usage_events
  add column if not exists search_requests integer check (search_requests is null or search_requests >= 0),
  add column if not exists usage_complete boolean not null default false,
  add column if not exists billing_ambiguous boolean not null default false;

create or replace function public.hydrate_capture_job_v2(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  payload jsonb;
begin
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker identity is required.';
  end if;
  select jsonb_build_object(
    'id', ri.id,
    'workspaceId', ri.workspace_id,
    'projectId', ri.project_id,
    'runId', ri.run_id,
    'questionId', qv.question_id,
    'questionVersionId', qv.id,
    'prompt', qv.prompt,
    'provider', ri.provider,
    'locale', ri.locale,
    'market', ri.market,
    'attemptCount', ri.attempt_count,
    'maxAttempts', ri.max_attempts,
    'leaseExpiresAt', ri.lease_expires_at,
    'providerConnection', case when pc.id is null then null else jsonb_build_object(
      'enabled', pc.enabled,
      'healthState', pc.health_state,
      'configuration', pc.configuration
    ) end,
    'brands', coalesce((
      select jsonb_agg(jsonb_build_object(
        'brandVersionId', bv.id,
        'brandId', bv.brand_id,
        'name', bv.name,
        'domain', bv.domain,
        'aliases', bv.aliases,
        'role', rbv.role,
        'position', rbv.position
      ) order by rbv.position)
      from public.run_brand_versions rbv
      join public.brand_versions bv on bv.id = rbv.brand_version_id
        and bv.project_id = rbv.project_id and bv.workspace_id = rbv.workspace_id
      where rbv.run_id = ri.run_id and rbv.project_id = ri.project_id
        and rbv.workspace_id = ri.workspace_id
    ), '[]'::jsonb)
  ) into payload
  from public.run_items ri
  join public.runs r on r.id = ri.run_id and r.project_id = ri.project_id
    and r.workspace_id = ri.workspace_id
  join public.question_versions qv on qv.id = ri.question_version_id
    and qv.project_id = ri.project_id and qv.workspace_id = ri.workspace_id
  left join public.provider_connections pc on pc.workspace_id = ri.workspace_id
    and pc.provider = ri.provider
  where ri.id = p_job_id and ri.status = 'leased' and ri.lease_owner = p_worker_id
    and ri.lease_expires_at > now() and r.cancelled_at is null;
  if payload is null then
    raise exception using errcode = '55000', message = 'Capture job is not actively leased by this worker.';
  end if;
  return payload;
end;
$$;

create or replace function public.complete_capture_job_v2(
  p_job_id uuid,
  p_worker_id text,
  p_access_method text,
  p_model_or_surface text,
  p_exact_prompt text,
  p_provider_request_id text,
  p_requested_at timestamptz,
  p_captured_at timestamptz,
  p_latency_ms integer,
  p_call_count integer,
  p_search_requests integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric,
  p_usage_complete boolean,
  p_billing_ambiguous boolean,
  p_raw_response jsonb,
  p_answer_text text,
  p_citations jsonb default '[]'::jsonb,
  p_classifications jsonb default '[]'::jsonb,
  p_classifier_name text default null,
  p_classifier_version text default null,
  p_classifier_input_hash text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.run_items%rowtype;
  question_id_value uuid;
  attempt_id_value uuid;
  observation_id_value uuid;
  classification_run_id_value uuid;
  item jsonb;
  frozen_brand_count integer;
begin
  if p_access_method not in ('api', 'search_api') or nullif(trim(p_model_or_surface), '') is null
    or nullif(trim(p_exact_prompt), '') is null or nullif(trim(p_answer_text), '') is null
    or p_raw_response is null or p_call_count is null or p_call_count < 1
    or p_search_requests < 0 or p_input_tokens < 0 or p_output_tokens < 0
    or p_estimated_cost_usd < 0 or p_estimated_cost_usd = 'NaN'::numeric
    or p_usage_complete is null or p_billing_ambiguous is null
    or p_latency_ms is null or p_latency_ms < 0
    or p_requested_at is null or p_captured_at is null or p_captured_at < p_requested_at
    or jsonb_typeof(coalesce(p_citations, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_classifications, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid completed capture payload.';
  end if;
  select * into job from public.run_items where id = p_job_id for update;
  if not found or job.status <> 'leased' or job.lease_owner <> p_worker_id
    or job.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'Capture job is not leased by this worker.';
  end if;
  select qv.question_id into question_id_value from public.question_versions qv
  where qv.id = job.question_version_id and qv.project_id = job.project_id
    and qv.workspace_id = job.workspace_id;
  if question_id_value is null then
    raise exception using errcode = '23503', message = 'Question version is outside the job workspace.';
  end if;
  select count(*) into frozen_brand_count from public.run_brand_versions rbv
  where rbv.run_id = job.run_id and rbv.project_id = job.project_id
    and rbv.workspace_id = job.workspace_id;
  if frozen_brand_count = 0 or jsonb_array_length(p_classifications) <> frozen_brand_count
    or exists (
      select 1 from jsonb_array_elements(p_classifications) c
      left join public.run_brand_versions rbv on rbv.run_id = job.run_id
        and rbv.project_id = job.project_id and rbv.workspace_id = job.workspace_id
        and rbv.brand_version_id = nullif(c->>'brandVersionId', '')::uuid
      where rbv.brand_version_id is null
    ) or (
      select count(distinct c->>'brandVersionId') from jsonb_array_elements(p_classifications) c
    ) <> frozen_brand_count then
    raise exception using errcode = '22023', message = 'Classifications must exactly match the frozen run brand cohort.';
  end if;
  if p_classifier_name is null or p_classifier_version is null or p_classifier_input_hash is null then
    raise exception using errcode = '22023', message = 'Classifier identity is required.';
  end if;

  insert into public.capture_attempts (
    workspace_id, project_id, run_item_id, attempt_number, status, access_method,
    model_or_surface, exact_prompt, provider_request_id, requested_at, captured_at,
    latency_ms, call_count, search_requests, input_tokens, output_tokens,
    estimated_cost_usd, usage_complete, billing_ambiguous, raw_response, answer_text
  ) values (
    job.workspace_id, job.project_id, job.id, job.attempt_count, 'succeeded',
    p_access_method, p_model_or_surface, p_exact_prompt, p_provider_request_id,
    p_requested_at, p_captured_at, p_latency_ms, p_call_count, p_search_requests,
    p_input_tokens, p_output_tokens, p_estimated_cost_usd, p_usage_complete,
    p_billing_ambiguous, p_raw_response, p_answer_text
  ) returning id into attempt_id_value;

  insert into public.observations (
    workspace_id, project_id, run_id, question_id, provider, status, access_method,
    model_or_surface, provider_request_id, captured_at, raw_response, answer_text,
    run_item_id, capture_attempt_id
  ) values (
    job.workspace_id, job.project_id, job.run_id, question_id_value, job.provider,
    'succeeded', p_access_method, p_model_or_surface, p_provider_request_id,
    p_captured_at, p_raw_response, p_answer_text, job.id, attempt_id_value
  ) returning id into observation_id_value;

  for item in select value from jsonb_array_elements(coalesce(p_citations, '[]'::jsonb)) loop
    insert into public.citations (
      workspace_id, project_id, observation_id, url, original_url, canonical_url,
      title, position, evidence_excerpt
    ) values (
      job.workspace_id, job.project_id, observation_id_value, item->>'url',
      coalesce(item->>'originalUrl', item->>'url'), coalesce(item->>'canonicalUrl', item->>'url'),
      item->>'title', nullif(item->>'position', '')::integer, item->>'evidenceExcerpt'
    ) on conflict (observation_id, url) do nothing;
  end loop;

  insert into public.classification_runs (
    workspace_id, project_id, observation_id, classifier_name, classifier_version, input_hash
  ) values (
    job.workspace_id, job.project_id, observation_id_value,
    p_classifier_name, p_classifier_version, p_classifier_input_hash
  ) returning id into classification_run_id_value;
  for item in select value from jsonb_array_elements(p_classifications) loop
    insert into public.brand_classifications (
      workspace_id, project_id, classification_run_id, observation_id,
      brand_version_id, mentioned, cited, shortlisted, explicitly_recommended,
      first_choice, rejected, rank, confidence, evidence_spans, rationale, review_status
    ) values (
      job.workspace_id, job.project_id, classification_run_id_value, observation_id_value,
      (item->>'brandVersionId')::uuid, coalesce((item->>'mentioned')::boolean, false),
      coalesce((item->>'cited')::boolean, false), coalesce((item->>'shortlisted')::boolean, false),
      coalesce((item->>'explicitlyRecommended')::boolean, false),
      coalesce((item->>'firstChoice')::boolean, false), coalesce((item->>'rejected')::boolean, false),
      nullif(item->>'rank', '')::integer, coalesce((item->>'confidence')::numeric, 0),
      coalesce(item->'evidenceSpans', '[]'::jsonb), coalesce(item->>'rationale', ''),
      case when coalesce((item->>'requiresReview')::boolean, false)
        then 'pending'::public.review_status else 'not_required'::public.review_status end
    );
  end loop;

  insert into public.usage_events (
    workspace_id, project_id, run_id, run_item_id, capture_attempt_id, provider,
    call_count, search_requests, input_tokens, output_tokens, estimated_cost_usd,
    usage_complete, billing_ambiguous, idempotency_key
  ) values (
    job.workspace_id, job.project_id, job.run_id, job.id, attempt_id_value, job.provider,
    p_call_count, p_search_requests, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_estimated_cost_usd, 0), p_usage_complete, p_billing_ambiguous,
    'capture:' || attempt_id_value::text
  );

  update public.run_items set status = 'succeeded', completed_at = now(),
    lease_owner = null, lease_expires_at = null, last_error_code = null where id = job.id;
  update public.runs r set
    status = case
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')) then r.status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded')
        and exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('failed', 'unavailable', 'cancelled')) then 'partial'::public.run_status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded') then 'succeeded'::public.run_status
      else 'failed'::public.run_status end,
    completed_at = case when not exists (
      select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')
    ) then now() else r.completed_at end
  where r.id = job.run_id;
  return observation_id_value;
end;
$$;

create or replace function public.fail_capture_job_v2(
  p_job_id uuid,
  p_worker_id text,
  p_status public.observation_status,
  p_access_method text,
  p_model_or_surface text,
  p_exact_prompt text,
  p_provider_request_id text,
  p_requested_at timestamptz,
  p_captured_at timestamptz,
  p_latency_ms integer,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_retry_at timestamptz,
  p_call_count integer,
  p_search_requests integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric,
  p_usage_complete boolean,
  p_billing_ambiguous boolean,
  p_raw_response jsonb default null
)
returns public.job_status
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.run_items%rowtype;
  next_status public.job_status;
  attempt_id_value uuid;
begin
  if p_status is null or p_status = 'succeeded' or nullif(trim(p_error_code), '') is null
    or nullif(trim(p_error_message), '') is null or p_retryable is null
    or p_access_method not in ('api', 'search_api') or nullif(trim(p_model_or_surface), '') is null
    or nullif(trim(p_exact_prompt), '') is null or p_call_count is null or p_call_count < 0
    or p_search_requests < 0 or p_input_tokens < 0 or p_output_tokens < 0
    or p_estimated_cost_usd < 0 or p_estimated_cost_usd = 'NaN'::numeric
    or p_usage_complete is null or p_billing_ambiguous is null
    or p_latency_ms is null or p_latency_ms < 0
    or p_requested_at is null or p_captured_at is null or p_captured_at < p_requested_at then
    raise exception using errcode = '22023', message = 'Invalid failed capture payload.';
  end if;
  select * into job from public.run_items where id = p_job_id for update;
  if not found or job.status <> 'leased' or job.lease_owner <> p_worker_id
    or job.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'Capture job is not leased by this worker.';
  end if;
  if p_retry_at is not null and p_retry_at > now() + interval '1 day' then
    raise exception using errcode = '22023', message = 'Retry delay exceeds the worker bound.';
  end if;
  insert into public.capture_attempts (
    workspace_id, project_id, run_item_id, attempt_number, status, access_method,
    model_or_surface, exact_prompt, provider_request_id, requested_at, captured_at,
    latency_ms, call_count, search_requests, input_tokens, output_tokens,
    estimated_cost_usd, usage_complete, billing_ambiguous, raw_response,
    error_code, error_message, retryable
  ) values (
    job.workspace_id, job.project_id, job.id, job.attempt_count, p_status,
    p_access_method, p_model_or_surface, p_exact_prompt, p_provider_request_id,
    p_requested_at, p_captured_at, p_latency_ms, p_call_count, p_search_requests,
    p_input_tokens, p_output_tokens, p_estimated_cost_usd, p_usage_complete,
    p_billing_ambiguous, p_raw_response, p_error_code, left(p_error_message, 1000), p_retryable
  ) returning id into attempt_id_value;
  insert into public.usage_events (
    workspace_id, project_id, run_id, run_item_id, capture_attempt_id, provider,
    call_count, search_requests, input_tokens, output_tokens, estimated_cost_usd,
    usage_complete, billing_ambiguous, idempotency_key
  ) values (
    job.workspace_id, job.project_id, job.run_id, job.id, attempt_id_value, job.provider,
    p_call_count, p_search_requests, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_estimated_cost_usd, 0), p_usage_complete, p_billing_ambiguous,
    'capture:' || attempt_id_value::text
  );
  next_status := case
    when p_retryable and job.attempt_count < job.max_attempts then 'queued'::public.job_status
    when p_status = 'unavailable' then 'unavailable'::public.job_status
    else 'failed'::public.job_status end;
  update public.run_items set status = next_status, lease_owner = null,
    lease_expires_at = null, last_error_code = p_error_code,
    available_at = case when next_status = 'queued' then greatest(coalesce(p_retry_at, now()), now()) else available_at end,
    completed_at = case when next_status in ('failed', 'unavailable') then now() else completed_at end
  where id = job.id;
  if next_status <> 'queued' then
    update public.runs r set
      status = case
        when exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')) then r.status
        when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded') then 'partial'::public.run_status
        else 'failed'::public.run_status end,
      completed_at = case when not exists (
        select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')
      ) then now() else r.completed_at end
    where r.id = job.run_id;
  end if;
  return next_status;
end;
$$;

revoke all on function public.hydrate_capture_job_v2(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_capture_job_v2(uuid, text, text, text, text, text, timestamptz, timestamptz, integer, integer, integer, integer, integer, numeric, boolean, boolean, jsonb, text, jsonb, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_capture_job_v2(uuid, text, public.observation_status, text, text, text, text, timestamptz, timestamptz, integer, text, text, boolean, timestamptz, integer, integer, integer, integer, numeric, boolean, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.hydrate_capture_job_v2(uuid, text) to service_role;
grant execute on function public.complete_capture_job_v2(uuid, text, text, text, text, text, timestamptz, timestamptz, integer, integer, integer, integer, integer, numeric, boolean, boolean, jsonb, text, jsonb, jsonb, text, text, text) to service_role;
grant execute on function public.fail_capture_job_v2(uuid, text, public.observation_status, text, text, text, text, timestamptz, timestamptz, integer, text, text, boolean, timestamptz, integer, integer, integer, integer, numeric, boolean, boolean, jsonb) to service_role;
