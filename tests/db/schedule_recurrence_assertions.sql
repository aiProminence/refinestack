-- Hosted-safe schedule recurrence and reset assertions. Every fixture is rolled back.
begin;

do $$
declare next_at timestamptz;
begin
  next_at := private.next_schedule_occurrence(
    'America/New_York', '09:00'::time, 'daily'::public.schedule_frequency,
    null::smallint, null::smallint,
    '2026-03-07 14:00:00+00'::timestamptz
  );
  if next_at <> '2026-03-08 13:00:00+00'::timestamptz then
    raise exception 'daily recurrence did not preserve 09:00 across DST: %', next_at;
  end if;

  next_at := private.next_schedule_occurrence(
    'UTC', '09:00'::time, 'monthly'::public.schedule_frequency,
    null::smallint, 31::smallint,
    '2026-01-31 09:00:00+00'::timestamptz
  );
  if next_at <> '2026-02-28 09:00:00+00'::timestamptz then
    raise exception 'monthly recurrence did not clamp to February month end: %', next_at;
  end if;

  next_at := private.next_schedule_occurrence(
    'UTC', '09:00'::time, 'monthly'::public.schedule_frequency,
    null::smallint, 31::smallint, next_at
  );
  if next_at <> '2026-03-31 09:00:00+00'::timestamptz then
    raise exception 'month-end recurrence lost the configured day 31: %', next_at;
  end if;
end;
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
  'schedule-owner@db.test', '', now(), '{"provider":"email","providers":["email"]}',
  '{}', now(), now(), '', '', '', ''
);
insert into public.workspaces (id, name, slug, created_by) values (
  '92000000-0000-0000-0000-000000000001', 'Schedule assertions',
  'schedule-assertions', '91000000-0000-0000-0000-000000000001'
);
insert into public.projects (
  id, workspace_id, name, domain, category, default_market, default_locale,
  languages, status, created_by
) values (
  '93000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001', 'Schedule project',
  'schedule.test', 'Test', 'US', 'en-US', array['en'], 'active',
  '91000000-0000-0000-0000-000000000001'
);
insert into public.questions (
  id, workspace_id, project_id, current_prompt, market, locale, active,
  question_type, persona, stage, rationale, state, created_by
) values (
  '94000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'Which platform is the strongest verified option?', 'US', 'en-US', true,
  'recommended_vendors', 'Operations leader', 'Evaluation',
  'Measures the monitored vendor decision at a stable local cadence.', 'active',
  '91000000-0000-0000-0000-000000000001'
);

do $$
declare question_version_id uuid; question_set_id uuid; schedule_id uuid;
begin
  select id into question_version_id from public.question_versions
  where question_id = '94000000-0000-0000-0000-000000000001' and version = 1;
  question_set_id := public.create_question_set(
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000001',
    'Schedule cohort', array[question_version_id]
  );

  begin
    insert into public.schedules (
      workspace_id, project_id, question_set_id, providers, name, frequency,
      timezone, local_time, overlap_policy, enabled, next_run_at, created_by
    ) values (
      '92000000-0000-0000-0000-000000000001',
      '93000000-0000-0000-0000-000000000001', question_set_id,
      array['openai'::public.provider_key], 'Invalid zone', 'daily',
      'Mars/Olympus_Mons', '09:00', 'skip', true, now() + interval '1 day',
      '91000000-0000-0000-0000-000000000001'
    );
    raise exception 'invalid timezone was accepted';
  exception when invalid_parameter_value then null;
  end;

  insert into public.schedules (
    workspace_id, project_id, question_set_id, providers, name, frequency,
    timezone, local_time, overlap_policy, enabled, next_run_at, created_by,
    consecutive_failures, circuit_opened_at
  ) values (
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001', question_set_id,
    array['openai'::public.provider_key], 'Reset circuit', 'weekly',
    'America/New_York', '09:00', 'skip', false, now() - interval '1 day',
    '91000000-0000-0000-0000-000000000001', 3, now() - interval '1 hour'
  ) returning id into schedule_id;

  perform public.reset_schedule_circuit(
    '92000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000001', schedule_id,
    '91000000-0000-0000-0000-000000000001'
  );
  if not exists (select 1 from public.schedules where id = schedule_id
    and enabled and consecutive_failures = 0 and circuit_opened_at is null
    and next_run_at > now()) then
    raise exception 'schedule circuit reset did not restore a future runnable schedule';
  end if;
end;
$$;

rollback;
