-- Hosted-safe behavioral assertions for ambiguous expired provider leases.
-- Every fixture and assertion is rolled back.
begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  'a1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'expired-lease@db.test', '', now(), '{"provider":"email","providers":["email"]}',
  '{}', now(), now(), '', '', '', ''
);

insert into public.workspaces (id, name, slug, created_by) values (
  'a2000000-0000-0000-0000-000000000001', 'Expired lease assertions',
  'expired-lease-assertions', 'a1000000-0000-0000-0000-000000000001'
);
insert into public.projects (
  id, workspace_id, name, domain, category, default_market, default_locale,
  languages, status, created_by
) values (
  'a3000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001', 'Lease project',
  'lease-assertions.test', 'Test', 'MY', 'en-MY', array['en'], 'active',
  'a1000000-0000-0000-0000-000000000001'
);
insert into public.questions (
  id, workspace_id, project_id, current_prompt, market, locale, active,
  question_type, persona, stage, rationale, state, created_by
) values (
  'a4000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001',
  'Which verified vendor best meets this procurement need?', 'MY', 'en-MY', true,
  'category_discovery', 'Procurement lead', 'Evaluation',
  'Measures a verified procurement choice.', 'active',
  'a1000000-0000-0000-0000-000000000001'
);

do $$
declare
  question_version_id uuid;
  recovered integer;
begin
  select id into question_version_id
  from public.question_versions
  where question_id = 'a4000000-0000-0000-0000-000000000001' and version = 1;

  insert into public.runs (
    id, workspace_id, project_id, status, requested_by, idempotency_key,
    requested_capture_count, reserved_call_count, reserved_cost_usd
  ) values (
    'a5000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001', 'running',
    'a1000000-0000-0000-0000-000000000001', 'expired-lease-run', 1, 2, 0.1
  );
  insert into public.run_items (
    id, workspace_id, project_id, run_id, question_version_id, provider,
    locale, market, status, idempotency_key, attempt_count, max_attempts,
    lease_owner, lease_started_at, lease_expires_at, started_at
  ) values (
    'a6000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    'a5000000-0000-0000-0000-000000000001', question_version_id, 'openai',
    'en-MY', 'MY', 'leased', 'expired-lease-item', 1, 2,
    'worker:expired', now() - interval '2 minutes', now() - interval '1 minute',
    now() - interval '2 minutes'
  );

  recovered := public.recover_expired_capture_leases(now());
  if recovered <> 1 then
    raise exception 'expected one recovered lease, got %', recovered;
  end if;
  if not exists (
    select 1 from public.capture_attempts ca
    where ca.run_item_id = 'a6000000-0000-0000-0000-000000000001'
      and ca.attempt_number = 1 and ca.status = 'failed'
      and ca.error_code = 'lease_expired' and ca.retryable
      and ca.call_count = 1 and ca.search_requests is null
      and not ca.usage_complete and ca.billing_ambiguous
      and ca.raw_response->>'billingState' = 'ambiguous'
  ) then
    raise exception 'expired lease did not create the immutable ambiguous attempt';
  end if;
  if not exists (
    select 1 from public.usage_events u
    where u.run_item_id = 'a6000000-0000-0000-0000-000000000001'
      and u.idempotency_key = 'lease-expired:a6000000-0000-0000-0000-000000000001:1'
      and u.call_count = 1 and u.search_requests is null
      and u.estimated_cost_usd = 0 and not u.usage_complete and u.billing_ambiguous
  ) then
    raise exception 'expired lease did not create the idempotent ambiguous usage event';
  end if;
  if not exists (
    select 1 from public.run_items ri
    where ri.id = 'a6000000-0000-0000-0000-000000000001'
      and ri.status = 'queued' and ri.last_error_code = 'lease_expired'
      and ri.lease_owner is null and ri.lease_expires_at is null
      and ri.lease_started_at is null
  ) then
    raise exception 'expired lease was not safely requeued with cleared lease metadata';
  end if;

  recovered := public.recover_expired_capture_leases(now());
  if recovered <> 0
    or (select count(*) from public.capture_attempts where run_item_id = 'a6000000-0000-0000-0000-000000000001') <> 1
    or (select count(*) from public.usage_events where run_item_id = 'a6000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'replayed recovery duplicated attempt or usage accounting';
  end if;
end;
$$;

rollback;
