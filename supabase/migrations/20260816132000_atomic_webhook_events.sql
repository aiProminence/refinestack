-- Enqueue webhook deliveries in the same transaction as authoritative state
-- changes. Stable event IDs make retries and concurrent workers idempotent.

create or replace function private.enqueue_webhook_deliveries(
  p_workspace_id uuid,
  p_event_name text,
  p_event_id uuid,
  p_data jsonb,
  p_created_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare inserted_count integer;
begin
  if p_event_name not in (
    'run.started', 'run.completed', 'run.partial', 'run.failed',
    'review.required', 'action.created', 'action.completed'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported webhook event.';
  end if;
  insert into public.webhook_deliveries (
    id, workspace_id, webhook_endpoint_id, event_id, event_name, payload,
    status, attempt_count, next_attempt_at
  )
  select generated.delivery_id, p_workspace_id, endpoint.id, p_event_id, p_event_name,
    jsonb_build_object(
      'id', p_event_id, 'event', p_event_name, 'createdAt', p_created_at,
      'workspaceId', p_workspace_id, 'deliveryId', generated.delivery_id,
      'data', coalesce(p_data, '{}'::jsonb)
    ), 'pending', 0, p_created_at
  from public.webhook_endpoints endpoint
  cross join lateral (select extensions.gen_random_uuid() as delivery_id) generated
  where endpoint.workspace_id = p_workspace_id and endpoint.enabled
    and p_event_name = any(endpoint.event_names)
  on conflict (webhook_endpoint_id, event_id) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;
revoke all on function private.enqueue_webhook_deliveries(uuid, text, uuid, jsonb, timestamptz)
from public, anon, authenticated;

create or replace function private.enqueue_run_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare event_name_value text;
begin
  if new.status = old.status then return new; end if;
  event_name_value := case new.status
    when 'running' then 'run.started'
    when 'succeeded' then 'run.completed'
    when 'partial' then 'run.partial'
    when 'failed' then 'run.failed'
    else null
  end;
  if event_name_value is not null then
    perform private.enqueue_webhook_deliveries(
      new.workspace_id, event_name_value,
      md5(new.id::text || ':' || event_name_value)::uuid,
      jsonb_build_object(
        'runId', new.id, 'projectId', new.project_id, 'status', new.status,
        'requestedCaptureCount', new.requested_capture_count
      ), coalesce(new.completed_at, new.started_at, now())
    );
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_run_webhook() from public, anon, authenticated;

create or replace function private.enqueue_classification_review_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.review_status = 'pending' then
    perform private.enqueue_webhook_deliveries(
      new.workspace_id, 'review.required',
      md5(new.id::text || ':review.required')::uuid,
      jsonb_build_object(
        'classificationId', new.id, 'observationId', new.observation_id,
        'projectId', new.project_id
      ), new.created_at
    );
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_classification_review_webhook() from public, anon, authenticated;

create or replace function private.enqueue_action_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare event_name_value text;
begin
  event_name_value := case
    when tg_op = 'INSERT' then 'action.created'
    when tg_op = 'UPDATE' and new.status = 'completed' and old.status <> 'completed' then 'action.completed'
    else null
  end;
  if event_name_value is not null then
    perform private.enqueue_webhook_deliveries(
      new.workspace_id, event_name_value,
      md5(new.id::text || ':' || event_name_value)::uuid,
      jsonb_build_object(
        'actionId', new.id, 'projectId', new.project_id,
        'status', new.status, 'title', new.title
      ), coalesce(new.completed_at, new.created_at)
    );
  end if;
  return new;
end;
$$;
revoke all on function private.enqueue_action_webhook() from public, anon, authenticated;

create trigger enqueue_run_webhook
after update of status on public.runs
for each row execute procedure private.enqueue_run_webhook();

create trigger enqueue_classification_review_webhook
after insert on public.brand_classifications
for each row execute procedure private.enqueue_classification_review_webhook();

create trigger enqueue_action_webhook
after insert or update of status on public.actions
for each row execute procedure private.enqueue_action_webhook();
