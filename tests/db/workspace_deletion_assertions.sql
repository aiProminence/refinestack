-- Hosted-safe AT-006 assertions. Run only after the matching migration. All
-- fixtures are transactional and the durable deletion receipt is rolled back.
begin;

do $$
begin
  if has_table_privilege('authenticated', 'public.workspaces', 'DELETE')
    or has_table_privilege('anon', 'public.workspaces', 'DELETE') then
    raise exception 'A client role can delete workspaces directly';
  end if;
  if has_function_privilege('authenticated', 'public.delete_workspace(uuid,uuid,text,text,timestamptz)', 'EXECUTE')
    or has_function_privilege('anon', 'public.delete_workspace(uuid,uuid,text,text,timestamptz)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.delete_workspace(uuid,uuid,text,text,timestamptz)', 'EXECUTE') then
    raise exception 'Workspace deletion RPC privilege boundary is incorrect';
  end if;
  if to_regclass('private.workspace_deletion_events') is null then
    raise exception 'Durable workspace deletion ledger is missing';
  end if;
  if to_regclass('private.workspace_storage_cleanup_jobs') is null
    or has_function_privilege('authenticated', 'public.claim_workspace_storage_cleanup_jobs(text,integer,integer,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.complete_workspace_storage_cleanup_job(uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_workspace_storage_cleanup_jobs(text,integer,integer,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.fail_workspace_storage_cleanup_job(uuid,text,text,boolean)', 'EXECUTE') then
    raise exception 'Storage cleanup queue or service-only privilege boundary is incorrect';
  end if;
end;
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'delete-owner@db.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'delete-admin@db.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into public.workspaces (id, name, slug, created_by) values
  ('92000000-0000-0000-0000-000000000001', 'Delete me exactly', 'delete-me-exactly', '91000000-0000-0000-0000-000000000001'),
  ('92000000-0000-0000-0000-000000000002', 'Keep me', 'keep-me', '91000000-0000-0000-0000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('92000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000002', 'admin');

insert into public.projects (
  id, workspace_id, name, domain, category, default_market, default_locale,
  languages, status, created_by
) values (
  '93000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001', 'Deletion evidence project',
  'delete.test', 'Test', 'MY', 'en-MY', array['en'], 'active',
  '91000000-0000-0000-0000-000000000001'
);
insert into public.sources (
  id, workspace_id, project_id, kind, name, state, created_by
) values (
  '94000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'file', 'Private evidence file', 'active',
  '91000000-0000-0000-0000-000000000001'
);
insert into public.source_versions (
  id, workspace_id, project_id, source_id, version, content_text, storage_path,
  content_hash, mime_type, retrieval_metadata, created_by
) values (
  '95000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000001', 1, 'Private evidence',
  '92000000-0000-0000-0000-000000000001/93000000-0000-0000-0000-000000000001/94000000-0000-0000-0000-000000000001/96000000-0000-0000-0000-000000000001-notes.txt',
  repeat('1', 64), 'text/plain', '{}',
  '91000000-0000-0000-0000-000000000001'
);

do $$
declare receipt jsonb; cleanup_id_value uuid; leases jsonb; cleanup_job_id_value uuid;
  revived_count integer;
begin
  begin
    perform public.delete_workspace(
      '92000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000002', 'delete-me-exactly', 'password', now()
    );
    raise exception 'admin deleted a workspace';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.delete_workspace(
      '92000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000001', 'DELETE-ME-EXACTLY', 'password', now()
    );
    raise exception 'inexact confirmation deleted a workspace';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform public.delete_workspace(
      '92000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000001', 'delete-me-exactly', 'password', now() - interval '6 minutes'
    );
    raise exception 'stale reauthentication deleted a workspace';
  exception when invalid_authorization_specification then null;
  end;

  begin
    perform public.delete_workspace(
      '92000000-0000-0000-0000-000000000002',
      '91000000-0000-0000-0000-000000000002', 'keep-me', 'password', now()
    );
    raise exception 'foreign non-owner deleted a workspace';
  exception when insufficient_privilege then null;
  end;

  receipt := public.delete_workspace(
    '92000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000001', 'delete-me-exactly', 'password', now()
  );
  cleanup_id_value := (receipt->>'storage_cleanup_id')::uuid;
  if receipt->>'id' <> '92000000-0000-0000-0000-000000000001'
    or exists (select 1 from public.workspaces where id = '92000000-0000-0000-0000-000000000001')
    or not exists (
      select 1 from private.workspace_deletion_events
      where id = (receipt->>'deletion_event_id')::uuid
        and workspace_id = '92000000-0000-0000-0000-000000000001'
        and actor_user_id = '91000000-0000-0000-0000-000000000001'
        and reauthentication_method = 'password'
    )
    or not exists (
      select 1 from private.workspace_storage_cleanup_batches batch
      where batch.id = cleanup_id_value and batch.workspace_id = '92000000-0000-0000-0000-000000000001'
        and batch.object_count = 1 and batch.status = 'pending'
    )
    or not exists (
      select 1 from private.workspace_storage_cleanup_jobs job
      where job.cleanup_id = cleanup_id_value
        and job.object_path = '92000000-0000-0000-0000-000000000001/93000000-0000-0000-0000-000000000001/94000000-0000-0000-0000-000000000001/96000000-0000-0000-0000-000000000001-notes.txt'
    ) then
    raise exception 'owner deletion did not atomically delete and retain its receipt: %', receipt;
  end if;

  leases := public.claim_workspace_storage_cleanup_jobs('worker:deletion-assertion', 10, 300, cleanup_id_value);
  if jsonb_array_length(leases) <> 1
    or leases->0->>'object_path' <> '92000000-0000-0000-0000-000000000001/93000000-0000-0000-0000-000000000001/94000000-0000-0000-0000-000000000001/96000000-0000-0000-0000-000000000001-notes.txt' then
    raise exception 'cleanup lease did not return the single exact captured object: %', leases;
  end if;
  cleanup_job_id_value := (leases->0->>'id')::uuid;
  update private.workspace_storage_cleanup_jobs set attempt_count = 8
  where id = cleanup_job_id_value;
  perform public.fail_workspace_storage_cleanup_job(
    cleanup_job_id_value, 'worker:deletion-assertion', 'storage_remove_failed', true
  );
  if not exists (
    select 1 from private.workspace_storage_cleanup_jobs
    where id = cleanup_job_id_value and status = 'abandoned' and available_at > now()
  ) then raise exception 'bounded cleanup cycle did not enter its visible cooldown'; end if;
  update private.workspace_storage_cleanup_jobs set available_at = now() - interval '1 minute'
  where id = cleanup_job_id_value;
  revived_count := public.revive_abandoned_storage_cleanup_jobs(now(), 10);
  if revived_count <> 1
    or not exists (
      select 1 from private.workspace_storage_cleanup_jobs
      where id = cleanup_job_id_value and status = 'pending' and attempt_count = 0
    ) then raise exception 'abandoned cleanup was not automatically recoverable'; end if;
  leases := public.claim_workspace_storage_cleanup_jobs('worker:deletion-assertion', 10, 300, cleanup_id_value);
  if jsonb_array_length(leases) <> 1 then
    raise exception 'revived cleanup was not leaseable: %', leases;
  end if;
  perform public.complete_workspace_storage_cleanup_job(cleanup_job_id_value, 'worker:deletion-assertion');
  if not exists (
    select 1 from private.workspace_storage_cleanup_batches batch
    where batch.id = cleanup_id_value and batch.status = 'succeeded' and batch.completed_at is not null
  ) or not exists (
    select 1 from private.workspace_storage_cleanup_attempts attempt
    where attempt.cleanup_job_id = cleanup_job_id_value and attempt.outcome = 'succeeded'
  ) then
    raise exception 'storage cleanup completion was not atomic and auditable';
  end if;
end;
$$;

rollback;
