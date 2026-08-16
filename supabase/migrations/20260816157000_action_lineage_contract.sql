-- AT-057 / AT-058: actions must start from immutable observed evidence and
-- completed actions must point to a later monitoring outcome without claiming
-- that the action caused that outcome.

do $legacy_integrity$
begin
  if exists (
    select 1
    from public.actions a
    where not exists (
      select 1 from public.action_links al
      where al.action_id = a.id
        and al.project_id = a.project_id
        and al.workspace_id = a.workspace_id
    )
  ) then
    raise exception using errcode = '23514',
      message = 'Existing actions without immutable lineage must be resolved before applying this migration.';
  end if;

  if exists (
    select 1 from public.actions a
    where char_length(trim(coalesce(a.expected_impact, ''))) < 3
      or char_length(trim(coalesce(a.effort, ''))) < 3
      or char_length(trim(coalesce(a.uncertainty, ''))) < 3
  ) then
    raise exception using errcode = '23514',
      message = 'Existing actions require expected impact, effort, and uncertainty before applying this migration.';
  end if;

  if exists (
    select 1 from public.action_links
    where num_nonnulls(question_version_id, classification_id, source_version_id) <> 1
  ) then
    raise exception using errcode = '23514',
      message = 'Existing action links must identify exactly one immutable record.';
  end if;
end;
$legacy_integrity$;

alter table public.actions
  alter column expected_impact set not null,
  alter column effort set not null,
  alter column uncertainty set not null,
  add constraint actions_expected_impact_length
    check (char_length(trim(expected_impact)) between 3 and 1000),
  add constraint actions_effort_length
    check (char_length(trim(effort)) between 3 and 1000),
  add constraint actions_uncertainty_length
    check (char_length(trim(uncertainty)) between 3 and 1000);

alter table public.action_links
  add constraint action_link_exactly_one_target
  check (num_nonnulls(question_version_id, classification_id, source_version_id) = 1);

alter table public.action_links
  add constraint action_link_rationale_length
  check (char_length(trim(rationale)) between 10 and 2000);

create index action_links_question_version_fk_idx
  on public.action_links(question_version_id, project_id, workspace_id)
  where question_version_id is not null;
create index action_links_classification_fk_idx
  on public.action_links(classification_id, project_id, workspace_id)
  where classification_id is not null;
create index action_links_source_version_fk_idx
  on public.action_links(source_version_id, project_id, workspace_id)
  where source_version_id is not null;

create table public.action_run_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  action_id uuid not null,
  run_id uuid not null,
  relationship_kind text not null default 'follow_up_observation'
    check (relationship_kind = 'follow_up_observation'),
  outcome_note text not null
    check (char_length(trim(outcome_note)) between 10 and 2000),
  causation_asserted boolean not null default false
    check (causation_asserted = false),
  linked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (action_id, project_id, workspace_id)
    references public.actions(id, project_id, workspace_id) on delete cascade,
  foreign key (run_id, project_id, workspace_id)
    references public.runs(id, project_id, workspace_id) on delete restrict,
  unique (id, project_id, workspace_id),
  unique (action_id, run_id)
);

alter table public.action_run_links enable row level security;

create policy action_run_links_read on public.action_run_links
for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

revoke all on public.action_run_links from anon, authenticated;
grant select on public.action_run_links to authenticated;
grant all on public.action_run_links to service_role;

create index action_run_links_workspace_project_idx
  on public.action_run_links(workspace_id, project_id, created_at desc);
create index action_run_links_action_fk_idx
  on public.action_run_links(action_id, project_id, workspace_id);
create index action_run_links_run_fk_idx
  on public.action_run_links(run_id, project_id, workspace_id);

-- Lineage cannot be rewritten. Direct mutation privileges are revoked below;
-- deferred constraints reject deletion of the last link while its action still
-- exists, while allowing project/workspace parent cascades to complete.
create or replace function private.protect_action_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'Action lineage is immutable.';
  return old;
end;
$$;

revoke all on function private.protect_action_lineage() from public, anon, authenticated;

create trigger protect_action_links
before update on public.action_links
for each row execute procedure private.protect_action_lineage();

create trigger protect_action_run_links
before update on public.action_run_links
for each row execute procedure private.protect_action_lineage();

create or replace function private.assert_action_has_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_id uuid;
  checked_project_id uuid;
  checked_workspace_id uuid;
begin
  if tg_table_name = 'actions' then
    checked_id := new.id;
    checked_project_id := new.project_id;
    checked_workspace_id := new.workspace_id;
  else
    checked_id := old.action_id;
    checked_project_id := old.project_id;
    checked_workspace_id := old.workspace_id;
  end if;
  if exists (
    select 1 from public.actions a
    where a.id = checked_id
      and a.project_id = checked_project_id
      and a.workspace_id = checked_workspace_id
  ) and not exists (
    select 1 from public.action_links al
    where al.action_id = checked_id
      and al.project_id = checked_project_id
      and al.workspace_id = checked_workspace_id
  ) then
    raise exception using errcode = '23514', message = 'An action requires immutable evidence lineage.';
  end if;
  return null;
end;
$$;

revoke all on function private.assert_action_has_lineage() from public, anon, authenticated;

create constraint trigger ensure_action_has_lineage
after insert or update of id, project_id, workspace_id on public.actions
deferrable initially deferred
for each row execute procedure private.assert_action_has_lineage();

create constraint trigger preserve_action_lineage_after_link_change
after update or delete on public.action_links
deferrable initially deferred
for each row execute procedure private.assert_action_has_lineage();

create or replace function private.assert_completed_action_has_follow_up()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_id uuid;
  checked_project_id uuid;
  checked_workspace_id uuid;
begin
  if tg_table_name = 'actions' then
    checked_id := new.id;
    checked_project_id := new.project_id;
    checked_workspace_id := new.workspace_id;
  else
    checked_id := old.action_id;
    checked_project_id := old.project_id;
    checked_workspace_id := old.workspace_id;
  end if;
  if exists (
    select 1 from public.actions a
    where a.id = checked_id
      and a.project_id = checked_project_id
      and a.workspace_id = checked_workspace_id
      and a.status = 'completed'
  ) and not exists (
    select 1 from public.action_run_links arl
    where arl.action_id = checked_id
      and arl.project_id = checked_project_id
      and arl.workspace_id = checked_workspace_id
  ) then
    raise exception using errcode = '23514',
      message = 'A completed action requires a later monitoring outcome link.';
  end if;
  return null;
end;
$$;

revoke all on function private.assert_completed_action_has_follow_up() from public, anon, authenticated;

create constraint trigger ensure_completed_action_has_follow_up
after insert or update of status on public.actions
deferrable initially deferred
for each row execute procedure private.assert_completed_action_has_follow_up();

create constraint trigger preserve_completed_action_follow_up
after update or delete on public.action_run_links
deferrable initially deferred
for each row execute procedure private.assert_completed_action_has_follow_up();

-- Direct mutation cannot preserve the cross-row invariants above. All action
-- writes therefore go through the service-only, actor-validating RPCs below.
drop policy if exists actions_insert on public.actions;
drop policy if exists actions_update on public.actions;
drop policy if exists actions_delete on public.actions;
drop policy if exists action_links_insert on public.action_links;
revoke insert, update, delete on public.actions from authenticated;
revoke insert, update, delete on public.action_links from authenticated;

create or replace function public.create_action_with_lineage(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_title text,
  p_description text,
  p_expected_impact text,
  p_effort text,
  p_uncertainty text,
  p_question_version_id uuid,
  p_classification_id uuid,
  p_source_version_id uuid,
  p_rationale text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.workspace_role;
  action_id_value uuid;
begin
  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null
    or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot create actions in this workspace.';
  end if;
  if not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '23503', message = 'Project was not found in this workspace.';
  end if;
  if char_length(trim(coalesce(p_title, ''))) not between 3 and 180
    or char_length(trim(coalesce(p_description, ''))) not between 10 and 4000
    or char_length(trim(coalesce(p_rationale, ''))) not between 10 and 2000
    or char_length(trim(coalesce(p_expected_impact, ''))) not between 3 and 1000
    or char_length(trim(coalesce(p_effort, ''))) not between 3 and 1000
    or char_length(trim(coalesce(p_uncertainty, ''))) not between 3 and 1000 then
    raise exception using errcode = '22023',
      message = 'A bounded title, description, rationale, impact, effort, and uncertainty are required.';
  end if;
  if num_nonnulls(p_question_version_id, p_classification_id, p_source_version_id) <> 1 then
    raise exception using errcode = '22023',
      message = 'Select exactly one immutable question, classification, or source version.';
  end if;
  if p_question_version_id is not null and not exists (
    select 1 from public.question_versions qv
    where qv.id = p_question_version_id
      and qv.project_id = p_project_id and qv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '23503', message = 'Question version was not found in this project.';
  end if;
  if p_classification_id is not null and not exists (
    select 1 from public.brand_classifications bc
    where bc.id = p_classification_id
      and bc.project_id = p_project_id and bc.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '23503', message = 'Classification was not found in this project.';
  end if;
  if p_source_version_id is not null and not exists (
    select 1 from public.source_versions sv
    where sv.id = p_source_version_id
      and sv.project_id = p_project_id and sv.workspace_id = p_workspace_id
  ) then
    raise exception using errcode = '23503', message = 'Source version was not found in this project.';
  end if;

  perform set_config('app.actor_user_id', p_actor_id::text, true);
  insert into public.actions (
    workspace_id, project_id, title, description, expected_impact, effort,
    uncertainty, created_by
  ) values (
    p_workspace_id, p_project_id, trim(p_title), trim(p_description),
    trim(p_expected_impact), trim(p_effort), trim(p_uncertainty), p_actor_id
  ) returning id into action_id_value;

  insert into public.action_links (
    workspace_id, project_id, action_id, question_version_id,
    classification_id, source_version_id, rationale
  ) values (
    p_workspace_id, p_project_id, action_id_value, p_question_version_id,
    p_classification_id, p_source_version_id, trim(p_rationale)
  );
  return action_id_value;
end;
$$;

revoke all on function public.create_action_with_lineage(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.create_action_with_lineage(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, text
) to service_role;

create or replace function public.transition_action_with_follow_up(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_action_id uuid,
  p_status public.action_status,
  p_follow_up_run_id uuid,
  p_outcome_note text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.workspace_role;
  action_row public.actions%rowtype;
  run_row public.runs%rowtype;
begin
  select wm.role into actor_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null
    or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot update actions in this workspace.';
  end if;

  select * into action_row from public.actions a
  where a.id = p_action_id and a.project_id = p_project_id
    and a.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception using errcode = '23503', message = 'Action was not found in this project.';
  end if;
  if action_row.status = 'completed' then
    if p_status = 'completed' and exists (
      select 1 from public.action_run_links arl
      where arl.action_id = action_row.id
        and arl.run_id = p_follow_up_run_id
        and arl.outcome_note = trim(coalesce(p_outcome_note, ''))
    ) then
      return action_row.id;
    end if;
    raise exception using errcode = '55000', message = 'Completed action lineage is immutable.';
  end if;

  perform set_config('app.actor_user_id', p_actor_id::text, true);
  if p_status = 'completed' then
    if p_follow_up_run_id is null
      or char_length(trim(coalesce(p_outcome_note, ''))) not between 10 and 2000 then
      raise exception using errcode = '22023',
        message = 'Completion requires a later monitoring run and a factual outcome note.';
    end if;
    select * into run_row from public.runs r
    where r.id = p_follow_up_run_id and r.project_id = p_project_id
      and r.workspace_id = p_workspace_id
    for share;
    if not found or run_row.created_at <= action_row.created_at
      or run_row.status not in ('succeeded', 'partial')
      or run_row.completed_at is null then
      raise exception using errcode = '23514',
        message = 'Follow-up must be a later completed monitoring run with usable observations.';
    end if;
    insert into public.action_run_links (
      workspace_id, project_id, action_id, run_id, outcome_note,
      causation_asserted, linked_by
    ) values (
      p_workspace_id, p_project_id, action_row.id, run_row.id,
      trim(p_outcome_note), false, p_actor_id
    );
    update public.actions
    set status = 'completed', completed_at = now(), updated_at = now()
    where id = action_row.id;
  else
    if p_follow_up_run_id is not null or nullif(trim(coalesce(p_outcome_note, '')), '') is not null then
      raise exception using errcode = '22023',
        message = 'Follow-up outcome fields are only valid when completing an action.';
    end if;
    update public.actions
    set status = p_status, completed_at = null, updated_at = now()
    where id = action_row.id;
  end if;
  return action_row.id;
end;
$$;

revoke all on function public.transition_action_with_follow_up(
  uuid, uuid, uuid, uuid, public.action_status, uuid, text
) from public, anon, authenticated;
grant execute on function public.transition_action_with_follow_up(
  uuid, uuid, uuid, uuid, public.action_status, uuid, text
) to service_role;

create trigger audit_material_mutation
after insert or update or delete on public.action_run_links
for each row execute procedure private.audit_material_mutation();
