-- Cross-instance API throttling. Immutable audit events remain the request
-- history; this small mutable counter is the atomic admission gate.

create table public.api_rate_limit_windows (
  token_id uuid not null references public.api_tokens(id) on delete cascade,
  scope text not null check (scope in ('read', 'run', 'export')),
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (token_id, scope, window_started_at)
);

alter table public.api_rate_limit_windows enable row level security;
revoke all on public.api_rate_limit_windows from public, anon, authenticated;

create or replace function public.consume_api_rate_limit(
  p_token_id uuid,
  p_scope text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  window_value timestamptz;
  next_count integer;
  reset_value timestamptz;
begin
  if p_scope not in ('read', 'run', 'export') or p_limit not between 1 and 10000
    or p_window_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid API rate-limit request.';
  end if;
  if not exists (
    select 1 from public.api_tokens t
    where t.id = p_token_id and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())
  ) then
    raise exception using errcode = '42501', message = 'API token is not active.';
  end if;
  window_value := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  reset_value := window_value + make_interval(secs => p_window_seconds);

  insert into public.api_rate_limit_windows (
    token_id, scope, window_started_at, request_count
  ) values (p_token_id, p_scope, window_value, 1)
  on conflict (token_id, scope, window_started_at) do update
    set request_count = public.api_rate_limit_windows.request_count + 1,
        updated_at = now()
    where public.api_rate_limit_windows.request_count < p_limit
  returning request_count into next_count;

  delete from public.api_rate_limit_windows
  where token_id = p_token_id and window_started_at < window_value - interval '1 day';

  if next_count is null then
    select request_count into next_count from public.api_rate_limit_windows
    where token_id = p_token_id and scope = p_scope and window_started_at = window_value;
    return jsonb_build_object(
      'allowed', false, 'used', coalesce(next_count, p_limit),
      'remaining', 0, 'resetAt', reset_value
    );
  end if;
  return jsonb_build_object(
    'allowed', true, 'used', next_count,
    'remaining', greatest(0, p_limit - next_count), 'resetAt', reset_value
  );
end;
$$;

revoke all on function public.consume_api_rate_limit(uuid, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, text, integer, integer)
to service_role;
