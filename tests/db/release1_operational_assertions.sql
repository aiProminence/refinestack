-- Hosted-safe behavioral assertions. Every fixture is rolled back.
begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '81000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'operational@db.test', '', now(), '{"provider":"email","providers":["email"]}',
  '{}', now(), now(), '', '', '', ''
);

insert into public.workspaces (id, name, slug, created_by) values (
  '82000000-0000-0000-0000-000000000001', 'Operational assertions',
  'operational-assertions', '81000000-0000-0000-0000-000000000001'
);
insert into public.projects (
  id, workspace_id, name, domain, category, default_market, default_locale,
  languages, status, created_by
) values (
  '83000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001', 'Assertions project',
  'assertions.test', 'Test', 'MY', 'en-MY', array['en'], 'active',
  '81000000-0000-0000-0000-000000000001'
);
insert into public.questions (
  id, workspace_id, project_id, current_prompt, market, locale, active,
  question_type, persona, stage, rationale, state, created_by
) values (
  '84000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  'Which provider is the strongest verified option?', 'MY', 'en-MY', true,
  'category_discovery', 'Procurement lead', 'Evaluation',
  'Measures the verified provider evaluation decision.', 'active',
  '81000000-0000-0000-0000-000000000001'
);

do $$
declare question_version_id uuid; first_run uuid; replay_run uuid; cancellation jsonb;
  evidence_source_id uuid; version_id uuid; before_version integer; after_version integer;
  otp_admission jsonb;
begin
  select id into question_version_id from public.question_versions
  where question_id = '84000000-0000-0000-0000-000000000001' and version = 1;
  if question_version_id is null then raise exception 'initial question snapshot is missing'; end if;

  update public.workspace_quotas set monthly_call_limit = 100, monthly_cost_limit_usd = 10
  where workspace_id = '82000000-0000-0000-0000-000000000001';
  first_run := public.create_monitoring_run(
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001', array[question_version_id],
    array['openai'::public.provider_key], 'operational-replay', 0
  );
  replay_run := public.create_monitoring_run(
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001', array[question_version_id],
    array['openai'::public.provider_key], 'operational-replay', 999
  );
  if replay_run <> first_run then raise exception 'idempotent replay created a second run'; end if;
  if not exists (select 1 from public.runs where id = first_run
    and reserved_call_count = 3 and reserved_cost_usd = 0.150000
    and estimated_max_cost_usd = 0.150000) then
    raise exception 'run did not reserve the authoritative OpenAI budget';
  end if;

  cancellation := public.cancel_monitoring_run(
    '82000000-0000-0000-0000-000000000001', first_run,
    '81000000-0000-0000-0000-000000000001', 'Acceptance test cancellation'
  );
  if cancellation->>'status' <> 'cancelled' or (cancellation->>'replayed')::boolean then
    raise exception 'first cancellation result is invalid: %', cancellation;
  end if;
  cancellation := public.cancel_monitoring_run(
    '82000000-0000-0000-0000-000000000001', first_run,
    '81000000-0000-0000-0000-000000000001', 'Ignored replay reason'
  );
  if not (cancellation->>'replayed')::boolean
    or cancellation->>'cancellation_reason' <> 'Acceptance test cancellation' then
    raise exception 'cancellation replay mutated first-write metadata: %', cancellation;
  end if;

  update public.workspace_quotas set monthly_cost_limit_usd = 0
  where workspace_id = '82000000-0000-0000-0000-000000000001';
  begin
    perform public.create_monitoring_run(
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '81000000-0000-0000-0000-000000000001', array[question_version_id],
      array['openai'::public.provider_key], 'cost-must-fail', 0
    );
    raise exception 'zero cost quota admitted a run';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.runs where idempotency_key = 'cost-must-fail') then
    raise exception 'failed cost admission left a run behind';
  end if;

  begin
    insert into public.questions (
      workspace_id, project_id, current_prompt, market, locale, active,
      question_type, state, created_by
    ) values (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      'Which incomplete question should never run?', 'MY', 'en-MY', true,
      'category_discovery', 'active', '81000000-0000-0000-0000-000000000001'
    );
    raise exception 'incomplete active question bypassed the database quality contract';
  exception when check_violation then null;
  end;
  begin
    insert into public.questions (
      workspace_id, project_id, current_prompt, market, locale, active,
      question_type, persona, stage, rationale, state, created_by
    ) values (
      '82000000-0000-0000-0000-000000000001',
      '83000000-0000-0000-0000-000000000001',
      '  Which provider is the strongest verified option?  ', 'MY', 'en-MY', true,
      'category_discovery', 'Procurement lead', 'Evaluation',
      'Measures the verified provider evaluation decision.', 'active',
      '81000000-0000-0000-0000-000000000001'
    );
    raise exception 'normalized duplicate active question bypassed the database boundary';
  exception when unique_violation then null;
  end;

  select current_version into before_version from public.questions
  where id = '84000000-0000-0000-0000-000000000001';
  update public.questions set state = 'disqualified',
    disqualification_reason = 'Outside the monitored category'
  where id = '84000000-0000-0000-0000-000000000001';
  select current_version into after_version from public.questions
  where id = '84000000-0000-0000-0000-000000000001';
  if after_version <> before_version + 1 or not exists (
    select 1 from public.question_versions where question_id = '84000000-0000-0000-0000-000000000001'
      and version = after_version and qualification->>'reason' = 'Outside the monitored category'
  ) then raise exception 'disqualification reason was not snapshotted'; end if;

  evidence_source_id := public.create_evidence_source(
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001', 'text', 'Policy evidence',
    null, null, 'version one', null, repeat('1', 64), 'text/plain', now(), '{}',
    true, false, false
  );
  version_id := public.append_evidence_source_version(
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001', evidence_source_id,
    '81000000-0000-0000-0000-000000000001', 'version two', null,
    repeat('2', 64), 'text/plain', now(), '{}'
  );
  if not exists (select 1 from public.source_versions where id = version_id
    and version = 2 and not quoting_allowed and not export_allowed)
    or not exists (select 1 from public.source_versions sv where sv.source_id = evidence_source_id
      and version = 1 and valid_until is not null) then
    raise exception 'evidence version history or policy snapshot is invalid';
  end if;
  perform public.archive_evidence_source(
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001', evidence_source_id,
    '81000000-0000-0000-0000-000000000001'
  );
  if not exists (select 1 from public.sources s where s.id = evidence_source_id and s.state = 'archived')
    or (select count(*) from public.source_versions sv where sv.source_id = evidence_source_id) <> 2 then
    raise exception 'evidence archive removed or failed to retain history';
  end if;

  insert into public.workspace_invitations (
    id, workspace_id, invitation_kind, email, role, invited_by, expires_at, signup_proof_hash
  ) values (
    '85000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', 'workspace', 'invitee@db.test',
    'viewer', '81000000-0000-0000-0000-000000000001', now() + interval '1 day', repeat('a', 64)
  );
  perform public.record_invitation_notification_delivery(
    '85000000-0000-0000-0000-000000000001', true, null,
    '81000000-0000-0000-0000-000000000001'
  );
  otp_admission := public.admit_invitation_mailbox_otp(
    '85000000-0000-0000-0000-000000000001', repeat('a', 64), null, null
  );
  if otp_admission->>'email' <> 'invitee@db.test'
    or not (otp_admission->>'should_create_user')::boolean then
    raise exception 'mailbox OTP admission did not preserve invitation binding: %', otp_admission;
  end if;
  perform public.finalize_invitation_mailbox_otp(
    '85000000-0000-0000-0000-000000000001', (otp_admission->>'attempt_id')::uuid,
    true, null
  );
  if not exists (select 1 from public.workspace_invitations
    where id = '85000000-0000-0000-0000-000000000001'
      and signup_proof_consumed_at is not null and otp_admission_status = 'sent') then
    raise exception 'successful OTP delivery did not consume the invitation claim';
  end if;
  begin
    perform public.admit_invitation_mailbox_otp(
      '85000000-0000-0000-0000-000000000001', repeat('a', 64), null, null
    );
    raise exception 'consumed invitation claim was admitted again';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
