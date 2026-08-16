-- Preserve exact private evidence object paths before workspace deletion, then
-- remove them through the Storage API using durable, bounded service-only jobs.

create table private.workspace_storage_cleanup_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  deletion_event_id uuid not null unique references private.workspace_deletion_events(id) on delete restrict,
  workspace_id uuid not null,
  object_count integer not null default 0 check (object_count >= 0),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'abandoned')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((status = 'succeeded') = (completed_at is not null))
);

create table private.workspace_storage_cleanup_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  cleanup_id uuid not null references private.workspace_storage_cleanup_batches(id) on delete restrict,
  deletion_event_id uuid not null references private.workspace_deletion_events(id) on delete restrict,
  workspace_id uuid not null,
  bucket_id text not null check (bucket_id = 'evidence-private'),
  object_path text not null check (length(object_path) between 3 and 1024),
  status text not null default 'pending' check (status in ('pending', 'leased', 'succeeded', 'abandoned')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  available_at timestamptz not null default clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text check (
    last_error_code is null or (
      length(last_error_code) between 1 and 80
      and last_error_code ~ '^[a-z0-9_:-]+$'
    )
  ),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (cleanup_id, bucket_id, object_path),
  check (
    (status = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check ((status = 'succeeded') = (completed_at is not null))
);

create index workspace_storage_cleanup_jobs_claim_idx
on private.workspace_storage_cleanup_jobs(status, available_at, lease_expires_at)
where status in ('pending', 'leased');
create index workspace_storage_cleanup_jobs_batch_idx
on private.workspace_storage_cleanup_jobs(cleanup_id, status);

create table private.workspace_storage_cleanup_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  cleanup_job_id uuid not null references private.workspace_storage_cleanup_jobs(id) on delete restrict,
  attempt_number integer not null check (attempt_number between 1 and 8),
  worker_id text not null,
  outcome text not null check (outcome in ('leased', 'succeeded', 'failed', 'abandoned')),
  error_code text check (
    error_code is null or (
      length(error_code) between 1 and 80 and error_code ~ '^[a-z0-9_:-]+$'
    )
  ),
  occurred_at timestamptz not null default clock_timestamp()
);
create index workspace_storage_cleanup_attempts_job_idx
on private.workspace_storage_cleanup_attempts(cleanup_job_id, occurred_at desc);

revoke all on table private.workspace_storage_cleanup_batches,
  private.workspace_storage_cleanup_jobs,
  private.workspace_storage_cleanup_attempts from public, anon, authenticated;
grant select, insert, update on table private.workspace_storage_cleanup_batches,
  private.workspace_storage_cleanup_jobs to service_role;
grant select, insert on table private.workspace_storage_cleanup_attempts to service_role;

create trigger immutable_workspace_storage_cleanup_attempts
before update or delete on private.workspace_storage_cleanup_attempts
for each row execute procedure private.prevent_immutable_mutation();

create or replace function private.protect_workspace_storage_cleanup_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.id, new.cleanup_id, new.deletion_event_id, new.workspace_id,
      new.bucket_id, new.object_path, new.created_at)
    is distinct from
    row(old.id, old.cleanup_id, old.deletion_event_id, old.workspace_id,
      old.bucket_id, old.object_path, old.created_at) then
    raise exception using errcode = '55000', message = 'Workspace storage cleanup identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_workspace_storage_cleanup_identity()
from public, anon, authenticated;
create trigger protect_workspace_storage_cleanup_identity
before update on private.workspace_storage_cleanup_jobs
for each row execute procedure private.protect_workspace_storage_cleanup_identity();

create or replace function public.claim_workspace_storage_cleanup_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 300,
  p_cleanup_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job_row private.workspace_storage_cleanup_jobs%rowtype;
  result jsonb := '[]'::jsonb;
  leased_at timestamptz := clock_timestamp();
begin
  if nullif(trim(p_worker_id), '') is null or length(p_worker_id) > 200
    or p_limit not between 1 and 100 or p_lease_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid storage cleanup lease request.';
  end if;

  -- A worker can disappear after taking the eighth and final lease. Convert
  -- those expired leases to an explicit terminal record instead of leaving a
  -- batch pending forever.
  for job_row in
    select job.* from private.workspace_storage_cleanup_jobs job
    where job.status = 'leased' and job.attempt_count >= 8
      and job.lease_expires_at <= leased_at
      and (p_cleanup_id is null or job.cleanup_id = p_cleanup_id)
    for update skip locked
  loop
    update private.workspace_storage_cleanup_jobs
    set status = 'abandoned', lease_owner = null, lease_expires_at = null,
        last_error_code = 'lease_expired'
    where id = job_row.id;
    insert into private.workspace_storage_cleanup_attempts (
      cleanup_job_id, attempt_number, worker_id, outcome, error_code
    ) values (
      job_row.id, job_row.attempt_count, job_row.lease_owner,
      'abandoned', 'lease_expired'
    );
    update private.workspace_storage_cleanup_batches set status = 'abandoned'
    where id = job_row.cleanup_id and status = 'pending';
  end loop;

  for job_row in
    select job.* from private.workspace_storage_cleanup_jobs job
    where (p_cleanup_id is null or job.cleanup_id = p_cleanup_id)
      and job.attempt_count < 8
      and (
        (job.status = 'pending' and job.available_at <= leased_at)
        or (job.status = 'leased' and job.lease_expires_at <= leased_at)
      )
    order by job.available_at, job.created_at, job.id
    for update skip locked
    limit p_limit
  loop
    update private.workspace_storage_cleanup_jobs
    set status = 'leased', attempt_count = attempt_count + 1,
        lease_owner = trim(p_worker_id),
        lease_expires_at = leased_at + make_interval(secs => p_lease_seconds),
        last_error_code = null
    where id = job_row.id
    returning * into job_row;

    insert into private.workspace_storage_cleanup_attempts (
      cleanup_job_id, attempt_number, worker_id, outcome
    ) values (job_row.id, job_row.attempt_count, job_row.lease_owner, 'leased');

    result := result || jsonb_build_array(jsonb_build_object(
      'id', job_row.id,
      'cleanup_id', job_row.cleanup_id,
      'workspace_id', job_row.workspace_id,
      'bucket_id', job_row.bucket_id,
      'object_path', job_row.object_path,
      'attempt_count', job_row.attempt_count
    ));
  end loop;
  return result;
end;
$$;

create or replace function public.complete_workspace_storage_cleanup_job(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job_row private.workspace_storage_cleanup_jobs%rowtype;
  completed_time timestamptz := clock_timestamp();
begin
  select * into job_row from private.workspace_storage_cleanup_jobs
  where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Storage cleanup job was not found.'; end if;
  if job_row.status <> 'leased' or job_row.lease_owner <> trim(p_worker_id) then
    raise exception using errcode = '42501', message = 'Storage cleanup lease is not owned by this worker.';
  end if;

  update private.workspace_storage_cleanup_jobs
  set status = 'succeeded', lease_owner = null, lease_expires_at = null,
      completed_at = completed_time, last_error_code = null
  where id = job_row.id;
  insert into private.workspace_storage_cleanup_attempts (
    cleanup_job_id, attempt_number, worker_id, outcome
  ) values (job_row.id, job_row.attempt_count, trim(p_worker_id), 'succeeded');

  if not exists (
    select 1 from private.workspace_storage_cleanup_jobs pending
    where pending.cleanup_id = job_row.cleanup_id and pending.status <> 'succeeded'
  ) then
    update private.workspace_storage_cleanup_batches
    set status = 'succeeded', completed_at = completed_time
    where id = job_row.cleanup_id and status = 'pending';
  end if;
  return jsonb_build_object('id', job_row.id, 'cleanup_id', job_row.cleanup_id, 'status', 'succeeded');
end;
$$;

create or replace function public.fail_workspace_storage_cleanup_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job_row private.workspace_storage_cleanup_jobs%rowtype;
  normalized_error text := nullif(lower(trim(p_error_code)), '');
  terminal boolean;
  retry_seconds integer;
begin
  if normalized_error is null or length(normalized_error) > 80
    or normalized_error !~ '^[a-z0-9_:-]+$' then
    raise exception using errcode = '22023', message = 'Invalid storage cleanup error code.';
  end if;
  select * into job_row from private.workspace_storage_cleanup_jobs
  where id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Storage cleanup job was not found.'; end if;
  if job_row.status <> 'leased' or job_row.lease_owner <> trim(p_worker_id) then
    raise exception using errcode = '42501', message = 'Storage cleanup lease is not owned by this worker.';
  end if;

  terminal := not p_retryable or job_row.attempt_count >= 8;
  retry_seconds := least(21600, floor(30 * power(4, greatest(job_row.attempt_count - 1, 0)))::integer);
  update private.workspace_storage_cleanup_jobs
  set status = case when terminal then 'abandoned' else 'pending' end,
      available_at = case when terminal then available_at else clock_timestamp() + make_interval(secs => retry_seconds) end,
      lease_owner = null, lease_expires_at = null,
      last_error_code = normalized_error
  where id = job_row.id;
  insert into private.workspace_storage_cleanup_attempts (
    cleanup_job_id, attempt_number, worker_id, outcome, error_code
  ) values (
    job_row.id, job_row.attempt_count, trim(p_worker_id),
    case when terminal then 'abandoned' else 'failed' end, normalized_error
  );
  if terminal then
    update private.workspace_storage_cleanup_batches set status = 'abandoned'
    where id = job_row.cleanup_id and status = 'pending';
  end if;
  return jsonb_build_object(
    'id', job_row.id, 'cleanup_id', job_row.cleanup_id,
    'status', case when terminal then 'abandoned' else 'pending' end,
    'attempt_count', job_row.attempt_count
  );
end;
$$;

revoke all on function public.claim_workspace_storage_cleanup_jobs(text, integer, integer, uuid)
from public, anon, authenticated;
revoke all on function public.complete_workspace_storage_cleanup_job(uuid, text)
from public, anon, authenticated;
revoke all on function public.fail_workspace_storage_cleanup_job(uuid, text, text, boolean)
from public, anon, authenticated;
grant execute on function public.claim_workspace_storage_cleanup_jobs(text, integer, integer, uuid)
to service_role;
grant execute on function public.complete_workspace_storage_cleanup_job(uuid, text)
to service_role;
grant execute on function public.fail_workspace_storage_cleanup_job(uuid, text, text, boolean)
to service_role;

create or replace function public.delete_workspace(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_confirmation text,
  p_reauthentication_method text,
  p_reauthenticated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  workspace_row public.workspaces%rowtype;
  actor_role public.workspace_role;
  confirmation_kind text;
  deletion_id uuid := extensions.gen_random_uuid();
  cleanup_id_value uuid := extensions.gen_random_uuid();
  deletion_time timestamptz := clock_timestamp();
  table_row record;
  affected integer;
  blocked integer;
  deleted_in_pass integer;
  storage_object_count integer;
begin
  if p_workspace_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = 'Workspace deletion identifiers are required.';
  end if;
  if p_reauthentication_method is null
    or p_reauthentication_method not in ('password', 'otp') then
    raise exception using errcode = '28000', message = 'Fresh reauthentication evidence is invalid.';
  end if;
  if p_reauthenticated_at is null
    or p_reauthenticated_at < deletion_time - interval '5 minutes'
    or p_reauthenticated_at > deletion_time + interval '1 minute' then
    raise exception using errcode = '28000', message = 'Fresh reauthentication is required.';
  end if;

  select * into workspace_row from public.workspaces
  where id = p_workspace_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Workspace was not found.'; end if;

  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is distinct from 'owner'::public.workspace_role then
    raise exception using errcode = '42501', message = 'Only a current workspace owner can delete this workspace.';
  end if;
  if p_confirmation = workspace_row.slug then confirmation_kind := 'slug';
  elsif p_confirmation = workspace_row.name then confirmation_kind := 'name';
  else raise exception using errcode = '22023', message = 'Workspace confirmation does not match.';
  end if;

  -- A path outside this exact tenant prefix indicates corrupt lineage. Abort
  -- before deleting database rows rather than deleting another tenant's object
  -- or silently leaving the current tenant's file behind.
  if exists (
    select 1 from public.source_versions sv
    where sv.workspace_id = p_workspace_id and sv.storage_path is not null
      and (
        sv.storage_path !~ ('^' || p_workspace_id::text || '/[^/]+/[^/]+/[^/]+$')
        or split_part(sv.storage_path, '/', 2) in ('', '.', '..')
        or split_part(sv.storage_path, '/', 3) in ('', '.', '..')
        or split_part(sv.storage_path, '/', 4) in ('', '.', '..')
      )
  ) then
    raise exception using errcode = '22000', message = 'Workspace evidence storage lineage is invalid.';
  end if;

  insert into private.workspace_deletion_events (
    id, workspace_id, workspace_name, workspace_slug, actor_user_id,
    confirmation_kind, reauthentication_method, reauthenticated_at, deleted_at
  ) values (
    deletion_id, workspace_row.id, workspace_row.name, workspace_row.slug, p_actor_id,
    confirmation_kind, p_reauthentication_method, p_reauthenticated_at, deletion_time
  );
  insert into private.workspace_storage_cleanup_batches (
    id, deletion_event_id, workspace_id, object_count, status, created_at
  ) values (cleanup_id_value, deletion_id, p_workspace_id, 0, 'pending', deletion_time);
  insert into private.workspace_storage_cleanup_jobs (
    cleanup_id, deletion_event_id, workspace_id, bucket_id, object_path, created_at, available_at
  )
  select cleanup_id_value, deletion_id, p_workspace_id, 'evidence-private', paths.storage_path,
    deletion_time, deletion_time
  from (
    select distinct sv.storage_path from public.source_versions sv
    where sv.workspace_id = p_workspace_id and sv.storage_path is not null
  ) paths;
  get diagnostics storage_object_count = row_count;
  update private.workspace_storage_cleanup_batches
  set object_count = storage_object_count,
      status = case when storage_object_count = 0 then 'succeeded' else 'pending' end,
      completed_at = case when storage_object_count = 0 then deletion_time else null end
  where id = cleanup_id_value;

  perform set_config('app.actor_user_id', p_actor_id::text, true);
  perform set_config('app.workspace_deletion_id', p_workspace_id::text, true);
  loop
    blocked := 0;
    deleted_in_pass := 0;
    for table_row in
      select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and c.relname <> 'workspaces' and a.attname = 'workspace_id' and not a.attisdropped
      order by c.relname
    loop
      begin
        execute format('delete from public.%I where workspace_id = $1', table_row.relname)
          using p_workspace_id;
        get diagnostics affected = row_count;
        deleted_in_pass := deleted_in_pass + affected;
      exception when foreign_key_violation then blocked := blocked + 1;
      end;
    end loop;
    exit when blocked = 0;
    if deleted_in_pass = 0 then
      raise exception using errcode = '2BP01', message = 'Workspace dependencies could not be removed safely.';
    end if;
  end loop;
  delete from public.workspaces where id = p_workspace_id;
  if not found then raise exception using errcode = 'P0002', message = 'Workspace was not found.'; end if;

  return jsonb_build_object(
    'id', workspace_row.id, 'name', workspace_row.name, 'slug', workspace_row.slug,
    'deletion_event_id', deletion_id, 'storage_cleanup_id', cleanup_id_value,
    'deleted_at', deletion_time
  );
end;
$$;

revoke all on function public.delete_workspace(uuid, uuid, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.delete_workspace(uuid, uuid, text, text, timestamptz)
to service_role;
