-- Hosted-safe AT-057 / AT-058 assertions. Run only after migration 1570.
-- Every fixture and deletion receipt is rolled back.
begin;

do $$
begin
  if has_table_privilege('authenticated', 'public.actions', 'INSERT')
    or has_table_privilege('authenticated', 'public.actions', 'UPDATE')
    or has_table_privilege('authenticated', 'public.action_links', 'INSERT')
    or has_table_privilege('authenticated', 'public.action_run_links', 'INSERT')
    or has_function_privilege(
      'authenticated',
      'public.create_action_with_lineage(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.transition_action_with_follow_up(uuid,uuid,uuid,uuid,public.action_status,uuid,text)',
      'EXECUTE'
    )
    or not has_table_privilege('authenticated', 'public.action_run_links', 'SELECT') then
    raise exception 'Action lineage privilege boundary is incorrect';
  end if;
end;
$$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'b1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated',
    'action-owner@db.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated',
    'action-viewer@db.test', '', now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
  );

insert into public.workspaces (id, name, slug, created_by) values (
  'b2000000-0000-0000-0000-000000000001', 'Action lineage assertions',
  'action-lineage-assertions', 'b1000000-0000-0000-0000-000000000001'
);
insert into public.workspace_members (workspace_id, user_id, role) values (
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002', 'viewer'
);

insert into public.projects (
  id, workspace_id, name, default_market, default_locale, languages, status, created_by
) values (
  'b3000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001', 'Action behavior project',
  'MY', 'en-MY', array['en'], 'active',
  'b1000000-0000-0000-0000-000000000001'
);
insert into public.sources (
  id, workspace_id, project_id, kind, name, state, created_by
) values (
  'b4000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000001',
  'text', 'Observed source', 'active',
  'b1000000-0000-0000-0000-000000000001'
);
insert into public.source_versions (
  id, workspace_id, project_id, source_id, version, content_text,
  content_hash, retrieval_metadata, created_by
) values (
  'b5000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001', 1, 'Observed gap',
  repeat('c', 64), '{}', 'b1000000-0000-0000-0000-000000000001'
);

do $$
declare
  action_id_value uuid;
begin
  begin
    perform public.create_action_with_lineage(
      'b2000000-0000-0000-0000-000000000001',
      'b3000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000002',
      'Viewer cannot mutate', 'This must be rejected atomically.',
      'No valid impact', 'No valid effort', 'No valid certainty', null, null,
      'b5000000-0000-0000-0000-000000000001',
      'A viewer must never create an action.'
    );
    raise exception 'Viewer created an action';
  exception when insufficient_privilege then null;
  end;

  action_id_value := public.create_action_with_lineage(
    'b2000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'Evidence correction', 'Publish one bounded evidence correction.',
    'Increase owned evidence coverage.', 'One editorial cycle.',
    'Provider retrieval may still vary.', null, null,
    'b5000000-0000-0000-0000-000000000001',
    'The immutable source version records an observed gap.'
  );
  if not exists (
    select 1 from public.actions a
    join public.action_links al on al.action_id = a.id
    where a.id = action_id_value
      and al.source_version_id = 'b5000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Atomic action creation did not retain its exact source version';
  end if;

  begin
    update public.action_links
    set rationale = 'Attempted rewrite of immutable lineage.'
    where action_id = action_id_value;
    raise exception 'Action lineage was updated';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.action_links where action_id = action_id_value;
    set constraints all immediate;
    raise exception 'Last action lineage was removed';
  exception when object_not_in_prerequisite_state then null;
  end;

  insert into public.runs (
    id, workspace_id, project_id, status, requested_by,
    requested_capture_count, reserved_call_count, reserved_cost_usd,
    started_at, completed_at, created_at
  ) values
    (
      'b6000000-0000-0000-0000-000000000001',
      'b2000000-0000-0000-0000-000000000001',
      'b3000000-0000-0000-0000-000000000001', 'succeeded',
      'b1000000-0000-0000-0000-000000000001', 0, 0, 0,
      now() - interval '2 hours', now() - interval '1 hour', now() - interval '2 hours'
    ),
    (
      'b6000000-0000-0000-0000-000000000002',
      'b2000000-0000-0000-0000-000000000001',
      'b3000000-0000-0000-0000-000000000001', 'partial',
      'b1000000-0000-0000-0000-000000000001', 0, 0, 0,
      now(), now() + interval '2 seconds', now() + interval '1 second'
    );

  begin
    perform public.transition_action_with_follow_up(
      'b2000000-0000-0000-0000-000000000001',
      'b3000000-0000-0000-0000-000000000001',
      'b1000000-0000-0000-0000-000000000001', action_id_value,
      'completed', 'b6000000-0000-0000-0000-000000000001',
      'The earlier run cannot measure this action.'
    );
    raise exception 'An earlier run completed the action';
  exception when check_violation then null;
  end;

  perform public.transition_action_with_follow_up(
    'b2000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001', action_id_value,
    'completed', 'b6000000-0000-0000-0000-000000000002',
    'The later run observed one additional owned citation.'
  );
  set constraints all immediate;
  if not exists (
    select 1
    from public.actions a
    join public.action_run_links arl on arl.action_id = a.id
    where a.id = action_id_value and a.status = 'completed'
      and a.completed_at is not null
      and arl.run_id = 'b6000000-0000-0000-0000-000000000002'
      and arl.relationship_kind = 'follow_up_observation'
      and not arl.causation_asserted
  ) then
    raise exception 'Valid completion lineage was not recorded without causation';
  end if;
end;
$$;

-- A project cascade must remove both starting and outcome lineage.
delete from public.projects where id = 'b3000000-0000-0000-0000-000000000001';
set constraints all immediate;
do $$
begin
  if exists (
    select 1 from public.actions
    where project_id = 'b3000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1 from public.action_links
    where project_id = 'b3000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1 from public.action_run_links
    where project_id = 'b3000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Project cascade retained action lineage';
  end if;
end;
$$;

-- Rebuild one uncompleted action, then exercise the authoritative workspace
-- deletion path to ensure lineage triggers do not block the full cascade.
set constraints all deferred;
insert into public.projects (
  id, workspace_id, name, default_market, default_locale, languages, status, created_by
) values (
  'b3000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000001', 'Workspace cascade project',
  'MY', 'en-MY', array['en'], 'active',
  'b1000000-0000-0000-0000-000000000001'
);
insert into public.sources (
  id, workspace_id, project_id, kind, name, state, created_by
) values (
  'b4000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000002',
  'text', 'Workspace cascade source', 'active',
  'b1000000-0000-0000-0000-000000000001'
);
insert into public.source_versions (
  id, workspace_id, project_id, source_id, version, content_text,
  content_hash, retrieval_metadata, created_by
) values (
  'b5000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000002',
  'b4000000-0000-0000-0000-000000000002', 1, 'Another observed gap',
  repeat('d', 64), '{}', 'b1000000-0000-0000-0000-000000000001'
);
select public.create_action_with_lineage(
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000001',
  'Workspace cascade action', 'Publish another bounded evidence correction.',
  'Increase owned evidence coverage.', 'One editorial cycle.',
  'Provider retrieval may still vary.', null, null,
  'b5000000-0000-0000-0000-000000000002',
  'The immutable source version records another observed gap.'
);
select public.delete_workspace(
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'action-lineage-assertions', 'password', now()
);
set constraints all immediate;
do $$
begin
  if exists (
    select 1 from public.workspaces
    where id = 'b2000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1 from public.actions
    where workspace_id = 'b2000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1 from public.action_links
    where workspace_id = 'b2000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Workspace cascade retained action lineage';
  end if;
end;
$$;

rollback;
