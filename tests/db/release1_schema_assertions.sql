-- Run after `supabase db reset` in an isolated local/test database.
-- Any failed invariant aborts the transaction without retaining fixtures.
begin;

do $$
declare
  labels text[];
  missing_rls text[];
  insecure_public_functions text[];
begin
  select array_agg(e.enumlabel order by e.enumsortorder) into labels
  from pg_type t join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'run_status';
  if labels <> array['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] then
    raise exception 'run_status is not canonical: %', labels;
  end if;
  select array_agg(e.enumlabel order by e.enumsortorder) into labels
  from pg_type t join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'source_state';
  if labels <> array['active', 'unavailable', 'archived'] then
    raise exception 'source_state is not canonical: %', labels;
  end if;

  if to_regclass('private.beta_invites') is not null then
    raise exception 'legacy private.beta_invites registry still exists';
  end if;
  if to_regclass('public.workspace_invitations') is null then
    raise exception 'workspace invitation registry is missing';
  end if;
  if position('workspace_invitations' in pg_get_functiondef('private.hook_require_beta_invite(jsonb)'::regprocedure)) = 0 then
    raise exception 'Auth hook is not backed by workspace_invitations';
  end if;
  if has_table_privilege('authenticated', 'public.workspaces', 'INSERT') then
    raise exception 'authenticated users can bypass explicit workspace bootstrap';
  end if;
  if has_column_privilege('authenticated', 'public.workspace_members', 'workspace_id', 'UPDATE')
    or has_column_privilege('authenticated', 'public.workspace_members', 'user_id', 'UPDATE') then
    raise exception 'authenticated users can rewrite membership identity keys';
  end if;

  select array_agg(c.relname order by c.relname) into missing_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if coalesce(cardinality(missing_rls), 0) > 0 then
    raise exception 'Public tables without RLS: %', missing_rls;
  end if;

  select array_agg(p.proname order by p.proname) into insecure_public_functions
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef;
  if coalesce(cardinality(insecure_public_functions), 0) > 0 then
    raise exception 'SECURITY DEFINER functions exist in public: %', insecure_public_functions;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'observations_run_project_workspace_fkey'
      and contype = 'f'
  ) or not exists (
    select 1 from pg_constraint where conname = 'observations_question_project_workspace_fkey'
      and contype = 'f'
  ) or not exists (
    select 1 from pg_constraint where conname = 'citations_observation_project_workspace_fkey'
      and contype = 'f'
  ) then
    raise exception 'Observation lineage lacks composite tenant foreign keys';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'protect_last_workspace_owner' and not tgisinternal
  ) then
    raise exception 'Last-owner protection trigger is missing';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'immutable_observations' and not tgisinternal
  ) then
    raise exception 'Raw observation immutability trigger is missing';
  end if;
  if to_regclass('public.run_brand_versions') is null
    or not exists (select 1 from pg_trigger where tgname = 'freeze_run_brand_versions' and not tgisinternal) then
    raise exception 'Runs do not freeze an immutable brand cohort';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'initialize_workspace_quota' and not tgisinternal
  ) then
    raise exception 'New workspaces do not receive an explicit hard quota';
  end if;

  if has_function_privilege('authenticated', 'public.lease_capture_jobs(text,integer,integer)', 'EXECUTE')
    or has_function_privilege('anon', 'public.lease_capture_jobs(text,integer,integer)', 'EXECUTE') then
    raise exception 'Worker lease RPC is exposed to a client role';
  end if;
  if not has_function_privilege('service_role', 'public.lease_capture_jobs(text,integer,integer)', 'EXECUTE') then
    raise exception 'Worker lease RPC is unavailable to service_role';
  end if;
  if has_function_privilege('authenticated', 'public.create_question_set(uuid,uuid,uuid,text,uuid[])', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.create_question_set(uuid,uuid,uuid,text,uuid[])', 'EXECUTE') then
    raise exception 'Atomic question-set RPC privilege boundary is incorrect';
  end if;
  if has_function_privilege('authenticated', 'public.hydrate_capture_job_v2(uuid,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.hydrate_capture_job_v2(uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.hydrate_capture_job_v2(uuid,text)', 'EXECUTE') then
    raise exception 'Durable worker hydration RPC privilege boundary is incorrect';
  end if;
  if has_function_privilege('authenticated', 'public.consume_api_rate_limit(uuid,text,integer,integer)', 'EXECUTE')
    or has_function_privilege('anon', 'public.consume_api_rate_limit(uuid,text,integer,integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.consume_api_rate_limit(uuid,text,integer,integer)', 'EXECUTE') then
    raise exception 'Atomic API rate-limit RPC privilege boundary is incorrect';
  end if;
  if has_table_privilege('authenticated', 'public.classification_reviews', 'INSERT')
    or has_function_privilege('authenticated', 'public.submit_classification_review(uuid,uuid,uuid,uuid,public.review_status,text,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.submit_classification_review(uuid,uuid,uuid,uuid,public.review_status,text,jsonb)', 'EXECUTE') then
    raise exception 'Atomic classification review privilege boundary is incorrect';
  end if;
  if has_table_privilege('authenticated', 'public.runs', 'INSERT')
    or has_table_privilege('authenticated', 'public.question_sets', 'INSERT')
    or has_table_privilege('authenticated', 'public.question_set_items', 'INSERT')
    or has_table_privilege('authenticated', 'public.sources', 'INSERT')
    or has_table_privilege('authenticated', 'public.sources', 'UPDATE')
    or has_table_privilege('authenticated', 'public.sources', 'DELETE')
    or has_table_privilege('authenticated', 'public.source_versions', 'INSERT')
    or has_table_privilege('authenticated', 'public.source_claims', 'INSERT') then
    raise exception 'An authoritative snapshot or run can bypass its atomic RPC';
  end if;
  if has_function_privilege('authenticated', 'public.revoke_workspace_invitation(uuid,uuid,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.revoke_workspace_invitation(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'Invitation revocation RPC privilege boundary is incorrect';
  end if;
  if has_function_privilege('authenticated', 'public.admit_invitation_mailbox_otp(uuid,text,uuid,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.admit_invitation_mailbox_otp(uuid,text,uuid,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.admit_invitation_mailbox_otp(uuid,text,uuid,uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.finalize_invitation_mailbox_otp(uuid,uuid,boolean,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.finalize_invitation_mailbox_otp(uuid,uuid,boolean,text)', 'EXECUTE') then
    raise exception 'Invitation OTP admission RPC privilege boundary is incorrect';
  end if;
  if has_function_privilege('authenticated', 'public.cancel_monitoring_run(uuid,uuid,uuid,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.cancel_monitoring_run(uuid,uuid,uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.cancel_monitoring_run(uuid,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'Run cancellation RPC privilege boundary is incorrect';
  end if;
  if has_function_privilege('authenticated', 'public.append_evidence_source_version(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.append_evidence_source_version(uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.archive_evidence_source(uuid,uuid,uuid,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.archive_evidence_source(uuid,uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'Evidence lifecycle RPC privilege boundary is incorrect';
  end if;
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.questions'::regclass and attname = 'locale' and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.runs'::regclass and attname = 'request_fingerprint' and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.runs'::regclass and attname = 'reserved_call_count' and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.runs'::regclass and attname = 'reserved_cost_usd' and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.citations'::regclass and attname = 'source_version_id' and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.workspace_invitations'::regclass and attname = 'signup_proof_hash' and attnotnull and not attisdropped
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.workspace_invitations'::regclass and attname = 'signup_proof_consumed_at' and not attisdropped
  ) then
    raise exception 'A required locale, quota reservation, fingerprint, or invitation-proof field is missing';
  end if;
  if to_regclass('public.provider_budget_caps') is null
    or (select count(*) from public.provider_budget_caps) <> 3 then
    raise exception 'Authoritative provider budget caps are missing';
  end if;
  if not exists (select 1 from storage.buckets where id = 'evidence-private'
    and not public and file_size_limit = 1000000)
    or not exists (select 1 from pg_constraint where conname = 'citations_source_version_project_workspace_fkey') then
    raise exception 'Private evidence storage or managed citation lineage is incomplete';
  end if;
  if position('disqualification_reason' in pg_get_functiondef('private.bump_question_version()'::regprocedure)) = 0
    or position('disqualification_reason' in pg_get_functiondef('private.snapshot_question_version()'::regprocedure)) = 0 then
    raise exception 'Question disqualification reason is outside immutable versioning';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'enqueue_run_webhook' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'enqueue_classification_review_webhook' and not tgisinternal)
    or not exists (select 1 from pg_trigger where tgname = 'enqueue_action_webhook' and not tgisinternal) then
    raise exception 'Transactional webhook event triggers are incomplete';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'update_schedule_health_after_run' and not tgisinternal)
    or (select count(*) from pg_trigger where tgname = 'audit_material_mutation' and not tgisinternal) < 14 then
    raise exception 'Schedule circuit or authoritative audit triggers are incomplete';
  end if;
  if position('signup_proof_hash' in pg_get_functiondef('private.hook_require_beta_invite(jsonb)'::regprocedure)) = 0
    or position('otp_admission_status' in pg_get_functiondef('private.hook_require_beta_invite(jsonb)'::regprocedure)) = 0
    or position('signup_proof_consumed_at' in pg_get_functiondef('private.hook_require_beta_invite(jsonb)'::regprocedure)) = 0
    or position('invitation_proof' in pg_get_functiondef('private.handle_new_profile()'::regprocedure)) = 0 then
    raise exception 'Auth signup is not bound to the server-generated invitation proof';
  end if;
  if exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index index_row
        where index_row.indrelid = constraint_row.conrelid
          and index_row.indisvalid
          and (index_row.indkey::smallint[])[0:cardinality(constraint_row.conkey) - 1]
            = constraint_row.conkey
      )
  ) then
    raise exception 'A public foreign key lacks a covering index';
  end if;
end;
$$;

-- Independent classification facts must reject an impossible first-choice fact.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'classification_implications' and contype = 'c'
      and pg_get_constraintdef(oid) like '%first_choice%explicitly_recommended%'
  ) then
    raise exception 'Classification logical implication constraint is missing';
  end if;
end;
$$;

-- Adversarial role checks: an admin cannot self-promote, demote, or remove an
-- owner even when issuing SQL directly through the authenticated Data API role.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'owner1@db.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'admin@db.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'owner2@db.test', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into public.workspaces (id, name, slug, created_by)
values ('20000000-0000-0000-0000-000000000001', 'RLS test', 'rls-test', '10000000-0000-0000-0000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'admin'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'owner');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare affected integer;
begin
  update public.workspace_members set role = 'owner'
  where workspace_id = '20000000-0000-0000-0000-000000000001'
    and user_id = '10000000-0000-0000-0000-000000000002';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'admin self-promotion bypassed RLS'; end if;

  update public.workspace_members set role = 'viewer'
  where workspace_id = '20000000-0000-0000-0000-000000000001'
    and user_id = '10000000-0000-0000-0000-000000000003';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'admin demoted an owner'; end if;

  delete from public.workspace_members
  where workspace_id = '20000000-0000-0000-0000-000000000001'
    and user_id = '10000000-0000-0000-0000-000000000003';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'admin removed an owner'; end if;
end;
$$;
reset role;

rollback;
