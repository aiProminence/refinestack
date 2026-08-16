-- Close final adversarial integrity gaps without weakening authorized parent
-- deletion or tenant erasure.

-- Evidence uploads happen before their database row is written. A shared
-- workspace lock makes source/version insertion and workspace deletion
-- serializable: deletion either snapshots the committed path or the later
-- insert fails and the server removes its unreferenced upload.
create or replace function private.serialize_evidence_storage_lineage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.workspaces w where w.id = new.workspace_id for key share;
  if not found then
    raise exception using errcode = '23503', message = 'Evidence workspace no longer exists.';
  end if;
  return new;
end;
$$;
revoke all on function private.serialize_evidence_storage_lineage()
from public, anon, authenticated;

create trigger serialize_source_workspace_deletion
before insert on public.sources
for each row execute procedure private.serialize_evidence_storage_lineage();
create trigger serialize_source_version_workspace_deletion
before insert on public.source_versions
for each row execute procedure private.serialize_evidence_storage_lineage();

-- Claims may only be derived from a version whose parent source is still
-- active. This validates the immutable version and its real parent inside the
-- authoritative transaction rather than trusting a separate form source ID.
create or replace function private.require_active_claim_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.source_versions sv
    join public.sources s on s.id = sv.source_id
      and s.project_id = sv.project_id and s.workspace_id = sv.workspace_id
    where sv.id = new.source_version_id
      and sv.project_id = new.project_id and sv.workspace_id = new.workspace_id
      and s.state = 'active'
  ) then
    raise exception using errcode = '55000', message = 'Claims require an active evidence source.';
  end if;
  return new;
end;
$$;
revoke all on function private.require_active_claim_source()
from public, anon, authenticated;
create trigger require_active_claim_source
before insert on public.source_claims
for each row execute procedure private.require_active_claim_source();

-- Every lineage row is immutable during normal operation. Parent cascades
-- are permitted at nested trigger depth, and the audited workspace deletion
-- RPC remains the only direct child-sweep exception.
create or replace function private.protect_action_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and (
    pg_trigger_depth() > 1
    or nullif(current_setting('app.workspace_deletion_id', true), '') = old.workspace_id::text
  ) then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'Action lineage is immutable.';
end;
$$;
revoke all on function private.protect_action_lineage() from public, anon, authenticated;
drop trigger protect_action_links on public.action_links;
drop trigger protect_action_run_links on public.action_run_links;
create trigger protect_action_links
before update or delete on public.action_links
for each row execute procedure private.protect_action_lineage();
create trigger protect_action_run_links
before update or delete on public.action_run_links
for each row execute procedure private.protect_action_lineage();

-- Eight attempts form one bounded retry cycle, not permanent data loss. A
-- terminal failure cools down for 24 hours; the service worker explicitly
-- revives it into a new bounded cycle and the attempt ledger remains intact.
create or replace function private.schedule_abandoned_storage_cleanup_retry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'abandoned' and old.status is distinct from 'abandoned' then
    new.available_at := clock_timestamp() + interval '24 hours';
  end if;
  return new;
end;
$$;
revoke all on function private.schedule_abandoned_storage_cleanup_retry()
from public, anon, authenticated;
create trigger schedule_abandoned_storage_cleanup_retry
before update on private.workspace_storage_cleanup_jobs
for each row execute procedure private.schedule_abandoned_storage_cleanup_retry();

create or replace function public.revive_abandoned_storage_cleanup_jobs(
  p_now timestamptz default now(),
  p_limit integer default 100
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare revived integer;
begin
  if p_now is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Invalid storage cleanup revival request.';
  end if;
  with candidates as (
    select job.id, job.cleanup_id
    from private.workspace_storage_cleanup_jobs job
    where job.status = 'abandoned' and job.available_at <= p_now
    order by job.available_at, job.created_at, job.id
    for update skip locked
    limit p_limit
  ), revived_jobs as (
    update private.workspace_storage_cleanup_jobs job
    set status = 'pending', attempt_count = 0, available_at = p_now,
      lease_owner = null, lease_expires_at = null
    from candidates candidate
    where job.id = candidate.id
    returning job.cleanup_id
  )
  select count(*) into revived from revived_jobs;

  update private.workspace_storage_cleanup_batches batch
  set status = 'pending', completed_at = null
  where batch.status = 'abandoned' and exists (
    select 1 from private.workspace_storage_cleanup_jobs job
    where job.cleanup_id = batch.id and job.status = 'pending'
  );
  return revived;
end;
$$;
revoke all on function public.revive_abandoned_storage_cleanup_jobs(timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.revive_abandoned_storage_cleanup_jobs(timestamptz, integer)
to service_role;
