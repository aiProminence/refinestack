-- RefineStack Release 1 data and tenant-security foundation.
-- This migration is append-only and retains legacy columns where removing them
-- could destroy production history. Canonical run-status values are established
-- by the immediately preceding migration so PostgreSQL commits enum changes first.

create extension if not exists pgcrypto;

do $$ begin
  create type public.project_status as enum ('draft', 'active', 'archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.brand_role as enum ('primary', 'competitor');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.question_type as enum (
    'category_discovery', 'recommended_vendors', 'vendor_shortlist',
    'brand_comparison', 'alternatives', 'problem_solution', 'capability_fit',
    'industry_fit', 'persona_fit', 'pricing_value', 'trust_risk_compliance',
    'implementation_integration', 'regional_market', 'decision_criteria'
  );
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.question_state as enum ('active', 'disqualified', 'archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.source_kind as enum ('url', 'text', 'file');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.source_state as enum ('active', 'unavailable', 'deleted');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.job_status as enum ('queued', 'leased', 'succeeded', 'failed', 'unavailable', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.review_status as enum ('not_required', 'pending', 'approved', 'overridden');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.action_status as enum ('proposed', 'approved', 'in_progress', 'completed', 'dismissed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.schedule_frequency as enum ('daily', 'weekly', 'monthly');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.overlap_policy as enum ('skip', 'queue');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.webhook_delivery_status as enum ('pending', 'delivered', 'failed', 'abandoned');
exception when duplicate_object then null; end $$;

-- Shared, non-recursive authorization helpers. All SECURITY DEFINER functions
-- live outside exposed schemas, pin search_path, and have no PUBLIC execution.
create or replace function private.workspace_role_rank(value public.workspace_role)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case value
    when 'viewer' then 0
    when 'analyst' then 1
    when 'admin' then 2
    when 'owner' then 3
  end;
$$;

create or replace function private.current_workspace_role(target_workspace_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = (select auth.uid())
  limit 1;
$$;

create or replace function private.has_workspace_role(
  target_workspace_id uuid,
  minimum_role public.workspace_role
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.workspace_role_rank(private.current_workspace_role(target_workspace_id))
      >= private.workspace_role_rank(minimum_role),
    false
  );
$$;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.prevent_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I is immutable; create a new version instead', tg_table_name);
end;
$$;

revoke all on function private.workspace_role_rank(public.workspace_role) from public;
revoke all on function private.current_workspace_role(uuid) from public;
revoke all on function private.has_workspace_role(uuid, public.workspace_role) from public;
revoke all on function private.set_updated_at() from public;
revoke all on function private.prevent_immutable_mutation() from public;
grant usage on schema private to authenticated, supabase_auth_admin, service_role;
grant execute on function private.current_workspace_role(uuid) to authenticated;
grant execute on function private.has_workspace_role(uuid, public.workspace_role) to authenticated;

-- User creation creates identity only. Workspace creation and team membership are
-- explicit so an invited teammate is not silently given an orphan workspace.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists private.handle_new_user();

create or replace function private.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_profile() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure private.handle_new_profile();

alter table public.workspaces
  add column if not exists updated_at timestamptz not null default now();
alter table public.workspaces
  drop constraint if exists workspaces_created_by_fkey;
alter table public.workspaces
  add constraint workspaces_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete restrict;
alter table public.workspaces
  add constraint workspaces_id_workspace_unique unique (id);

create or replace function private.add_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (workspace_id, user_id) do update set role = 'owner';
  return new;
end;
$$;
revoke all on function private.add_workspace_owner() from public, anon, authenticated;
drop trigger if exists add_workspace_owner on public.workspaces;
create trigger add_workspace_owner
after insert on public.workspaces
for each row execute procedure private.add_workspace_owner();
drop trigger if exists set_workspaces_updated_at on public.workspaces;
create trigger set_workspaces_updated_at
before update on public.workspaces
for each row execute procedure private.set_updated_at();

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  invitation_kind text not null default 'workspace' check (invitation_kind in ('workspace', 'bootstrap')),
  email text not null check (email = lower(trim(email))),
  invited_user_id uuid references auth.users(id) on delete cascade,
  role public.workspace_role not null,
  invited_by uuid references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitation_terminal_state check (accepted_at is null or revoked_at is null),
  constraint invitation_shape check (
    (invitation_kind = 'bootstrap' and role = 'owner' and invited_by is null
      and ((workspace_id is null and accepted_at is null) or (workspace_id is not null and accepted_at is not null)))
    or (invitation_kind = 'workspace' and workspace_id is not null and invited_by is not null)
  )
);
create index workspace_invitations_user_idx on public.workspace_invitations(invited_user_id)
where invited_user_id is not null;
create unique index workspace_open_invitation_email_idx on public.workspace_invitations(workspace_id, email)
where invitation_kind = 'workspace' and accepted_at is null and revoked_at is null;
create unique index workspace_bootstrap_invitation_email_idx on public.workspace_invitations(email)
where invitation_kind = 'bootstrap' and accepted_at is null and revoked_at is null;

create or replace function private.validate_workspace_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_email text;
  inviter_role public.workspace_role;
begin
  if new.invited_user_id is not null then
    select lower(trim(u.email)) into actual_email
    from auth.users u where u.id = new.invited_user_id;
    if actual_email is null or actual_email <> new.email then
      raise exception using errcode = '23514', message = 'Invitation email must match the invited Auth user.';
    end if;
  end if;
  if new.invitation_kind = 'workspace' then
    select wm.role into inviter_role from public.workspace_members wm
    where wm.workspace_id = new.workspace_id and wm.user_id = new.invited_by;
    if inviter_role is null or private.workspace_role_rank(inviter_role) < private.workspace_role_rank('admin') then
      raise exception using errcode = '42501', message = 'Inviter must be a workspace admin or owner.';
    end if;
    if new.role = 'owner' and inviter_role <> 'owner' then
      raise exception using errcode = '42501', message = 'Only an owner can invite another owner.';
    end if;
  end if;
  if new.expires_at <= now() then
    raise exception using errcode = '23514', message = 'Invitation expiry must be in the future.';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_workspace_invitation() from public, anon, authenticated;

create or replace function private.accept_workspace_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.accepted_at is null and new.accepted_at is not null and new.workspace_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new.workspace_id, new.invited_user_id, new.role)
    on conflict (workspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.accept_workspace_membership() from public, anon, authenticated;

create trigger validate_workspace_invitation
before insert or update of workspace_id, invitation_kind, email, invited_user_id, invited_by, expires_at, role
on public.workspace_invitations
for each row execute procedure private.validate_workspace_invitation();
create trigger accept_workspace_membership
after update of accepted_at on public.workspace_invitations
for each row execute procedure private.accept_workspace_membership();

-- Replace the legacy beta-email registry with the single Release 1 invitation
-- registry while preserving the configured Auth hook function reference.
create or replace function private.hook_require_beta_invite(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare signup_email text := lower(trim(event->'user'->>'email'));
begin
  if signup_email is null or not exists (
    select 1 from public.workspace_invitations wi
    where wi.email = signup_email and wi.accepted_at is null and wi.revoked_at is null
      and wi.expires_at > now() and wi.invited_user_id is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This private beta is invitation-only.'
    ));
  end if;
  return '{}'::jsonb;
end;
$$;
revoke all on function private.hook_require_beta_invite(jsonb) from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_require_beta_invite(jsonb) to supabase_auth_admin;

create or replace function private.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;
  update public.workspace_invitations wi set invited_user_id = new.id
  where wi.email = lower(trim(new.email)) and wi.invited_user_id is null
    and wi.accepted_at is null and wi.revoked_at is null and wi.expires_at > now();
  return new;
end;
$$;
revoke all on function private.handle_new_profile() from public, anon, authenticated;
drop table if exists private.beta_invites;

create or replace function private.protect_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
    and (tg_op = 'DELETE' or new.role <> 'owner')
    and not exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = old.workspace_id
        and wm.user_id <> old.user_id
        and wm.role = 'owner'
    ) then
    raise exception using errcode = '23514', message = 'A workspace must retain at least one owner.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.protect_last_workspace_owner() from public, anon, authenticated;
drop trigger if exists protect_last_workspace_owner on public.workspace_members;
create trigger protect_last_workspace_owner
before update of role or delete on public.workspace_members
for each row execute procedure private.protect_last_workspace_owner();

create or replace function public.bootstrap_workspace_from_invitation(
  p_invitation_id uuid,
  p_user_id uuid,
  p_name text,
  p_slug text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare invitation public.workspace_invitations%rowtype;
declare workspace_id_value uuid;
begin
  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found or invitation.invitation_kind <> 'bootstrap'
    or invitation.invited_user_id <> p_user_id or invitation.accepted_at is not null
    or invitation.revoked_at is not null or invitation.expires_at <= now() then
    raise exception using errcode = '42501', message = 'Bootstrap invitation is invalid or expired.';
  end if;
  insert into public.workspaces (name, slug, created_by)
  values (p_name, p_slug, p_user_id) returning id into workspace_id_value;
  update public.workspace_invitations set workspace_id = workspace_id_value, accepted_at = now()
  where id = invitation.id;
  return workspace_id_value;
end;
$$;
revoke all on function public.bootstrap_workspace_from_invitation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.bootstrap_workspace_from_invitation(uuid, uuid, text, text) to service_role;

-- Projects are the workspace-scoped unit for one market/category programme.
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  domain text,
  category text,
  default_market text not null default 'Malaysia',
  default_locale text not null default 'en-MY',
  languages text[] not null default array['en']::text[],
  status public.project_status not null default 'draft',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, name)
);

insert into public.projects (workspace_id, name, created_by)
select w.id, 'Default project', w.created_by
from public.workspaces w
where not exists (select 1 from public.projects p where p.workspace_id = w.id);

alter table public.brands add column if not exists project_id uuid;
alter table public.brands add column if not exists role public.brand_role not null default 'competitor';
alter table public.brands add column if not exists updated_at timestamptz not null default now();
update public.brands b
set project_id = (select p.id from public.projects p where p.workspace_id = b.workspace_id order by p.created_at limit 1)
where b.project_id is null;
alter table public.brands alter column project_id set not null;
alter table public.brands
  add constraint brands_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade;
alter table public.brands add constraint brands_id_project_workspace_unique unique (id, project_id, workspace_id);

create table public.brand_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  brand_id uuid not null,
  alias text not null check (char_length(trim(alias)) between 1 and 200),
  requires_context boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (brand_id, project_id, workspace_id)
    references public.brands(id, project_id, workspace_id) on delete cascade
);
create unique index brand_aliases_brand_lower_alias_idx
  on public.brand_aliases(brand_id, lower(alias));

create table public.brand_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  brand_id uuid not null,
  version integer not null check (version > 0),
  name text not null,
  domain text not null,
  role public.brand_role not null,
  aliases jsonb not null default '[]'::jsonb check (jsonb_typeof(aliases) = 'array'),
  snapshot_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (brand_id, project_id, workspace_id)
    references public.brands(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (brand_id, version),
  unique (brand_id, snapshot_hash)
);

alter table public.buyer_decisions rename to questions;
alter table public.questions rename column prompt to current_prompt;
alter table public.questions add column project_id uuid;
alter table public.questions add column question_type public.question_type not null default 'category_discovery';
alter table public.questions add column persona text;
alter table public.questions add column stage text;
alter table public.questions add column rationale text;
alter table public.questions add column state public.question_state not null default 'active';
alter table public.questions add column disqualification_reason text;
alter table public.questions add column current_version integer not null default 1;
alter table public.questions add column updated_at timestamptz not null default now();
update public.questions q
set project_id = (select p.id from public.projects p where p.workspace_id = q.workspace_id order by p.created_at limit 1)
where q.project_id is null;
alter table public.questions alter column project_id set not null;
alter table public.questions
  add constraint questions_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade;
alter table public.questions add constraint questions_id_project_workspace_unique unique (id, project_id, workspace_id);
alter table public.questions drop constraint if exists buyer_decisions_created_by_fkey;
alter table public.questions
  add constraint questions_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

create table public.question_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  question_id uuid not null,
  version integer not null check (version > 0),
  prompt text not null check (char_length(prompt) between 10 and 4000),
  question_type public.question_type not null,
  persona text,
  stage text,
  market text not null,
  locale text not null,
  rationale text,
  qualification jsonb not null default '{}'::jsonb check (jsonb_typeof(qualification) = 'object'),
  snapshot_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (question_id, project_id, workspace_id)
    references public.questions(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (question_id, version),
  unique (question_id, snapshot_hash)
);

insert into public.question_versions (
  workspace_id, project_id, question_id, version, prompt, question_type,
  persona, stage, market, locale, rationale, snapshot_hash, created_by, created_at
)
select q.workspace_id, q.project_id, q.id, 1, q.current_prompt, q.question_type,
  q.persona, q.stage, q.market, q.market, q.rationale,
  encode(digest(q.current_prompt || '|' || q.market, 'sha256'), 'hex'),
  q.created_by, q.created_at
from public.questions q
on conflict (question_id, version) do nothing;

create table public.question_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  version integer not null default 1 check (version > 0),
  cohort_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (project_id, name, version)
);
create table public.question_set_items (
  workspace_id uuid not null,
  project_id uuid not null,
  question_set_id uuid not null,
  question_version_id uuid not null,
  position integer not null check (position > 0),
  primary key (question_set_id, question_version_id),
  foreign key (question_set_id, project_id, workspace_id)
    references public.question_sets(id, project_id, workspace_id) on delete cascade,
  foreign key (question_version_id, project_id, workspace_id)
    references public.question_versions(id, project_id, workspace_id) on delete restrict,
  unique (question_set_id, position)
);

create table public.project_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  version integer not null check (version > 0),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  configuration_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (project_id, version),
  unique (project_id, configuration_hash)
);

create or replace function private.snapshot_project_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot jsonb;
  next_version integer;
begin
  snapshot := jsonb_build_object(
    'name', new.name, 'domain', new.domain, 'category', new.category,
    'default_market', new.default_market, 'default_locale', new.default_locale,
    'languages', to_jsonb(new.languages), 'status', new.status
  );
  select coalesce(max(pv.version), 0) + 1 into next_version
  from public.project_versions pv where pv.project_id = new.id;
  insert into public.project_versions (
    workspace_id, project_id, version, configuration, configuration_hash, created_by
  ) values (
    new.workspace_id, new.id, next_version, snapshot,
    encode(digest(snapshot::text, 'sha256'), 'hex'), coalesce((select auth.uid()), new.created_by)
  ) on conflict (project_id, configuration_hash) do nothing;
  return new;
end;
$$;
revoke all on function private.snapshot_project_version() from public, anon, authenticated;

create or replace function private.bump_question_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(old.current_prompt, old.question_type, old.persona, old.stage, old.market, old.rationale, old.state)
     is distinct from
     row(new.current_prompt, new.question_type, new.persona, new.stage, new.market, new.rationale, new.state) then
    new.current_version := old.current_version + 1;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_question_version() from public;

create or replace function private.snapshot_question_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare snapshot_hash_value text;
begin
  snapshot_hash_value := encode(digest(concat_ws('|', new.current_prompt, new.question_type::text,
    new.persona, new.stage, new.market, new.rationale, new.state::text), 'sha256'), 'hex');
  insert into public.question_versions (
    workspace_id, project_id, question_id, version, prompt, question_type,
    persona, stage, market, locale, rationale, qualification, snapshot_hash, created_by
  ) values (
    new.workspace_id, new.project_id, new.id, new.current_version, new.current_prompt,
    new.question_type, new.persona, new.stage, new.market, new.market, new.rationale,
    jsonb_build_object('state', new.state, 'reason', new.disqualification_reason),
    snapshot_hash_value, coalesce((select auth.uid()), new.created_by)
  ) on conflict (question_id, snapshot_hash) do nothing;
  return new;
end;
$$;
revoke all on function private.snapshot_question_version() from public, anon, authenticated;

create or replace function private.snapshot_brand_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  aliases_value jsonb;
  snapshot_hash_value text;
  next_version integer;
begin
  select coalesce(jsonb_agg(ba.alias order by lower(ba.alias)), '[]'::jsonb)
  into aliases_value from public.brand_aliases ba where ba.brand_id = new.id;
  snapshot_hash_value := encode(digest(concat_ws('|', new.name, new.domain, new.role::text, aliases_value::text), 'sha256'), 'hex');
  select coalesce(max(bv.version), 0) + 1 into next_version
  from public.brand_versions bv where bv.brand_id = new.id;
  insert into public.brand_versions (
    workspace_id, project_id, brand_id, version, name, domain, role, aliases,
    snapshot_hash, created_by
  ) values (
    new.workspace_id, new.project_id, new.id, next_version, new.name, new.domain,
    new.role, aliases_value, snapshot_hash_value, (select auth.uid())
  ) on conflict (brand_id, snapshot_hash) do nothing;
  return new;
end;
$$;
revoke all on function private.snapshot_brand_version() from public, anon, authenticated;

create or replace function private.snapshot_brand_from_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_brand_id uuid;
  brand_row public.brands%rowtype;
  aliases_value jsonb;
  snapshot_hash_value text;
  next_version integer;
begin
  if tg_op = 'DELETE' then target_brand_id := old.brand_id;
  else target_brand_id := new.brand_id;
  end if;
  select * into brand_row from public.brands where id = target_brand_id;
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  select coalesce(jsonb_agg(ba.alias order by lower(ba.alias)), '[]'::jsonb)
  into aliases_value from public.brand_aliases ba where ba.brand_id = target_brand_id;
  snapshot_hash_value := encode(digest(concat_ws('|', brand_row.name, brand_row.domain,
    brand_row.role::text, aliases_value::text), 'sha256'), 'hex');
  select coalesce(max(bv.version), 0) + 1 into next_version
  from public.brand_versions bv where bv.brand_id = target_brand_id;
  insert into public.brand_versions (
    workspace_id, project_id, brand_id, version, name, domain, role, aliases,
    snapshot_hash, created_by
  ) values (
    brand_row.workspace_id, brand_row.project_id, brand_row.id, next_version,
    brand_row.name, brand_row.domain, brand_row.role, aliases_value,
    snapshot_hash_value, (select auth.uid())
  ) on conflict (brand_id, snapshot_hash) do nothing;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
revoke all on function private.snapshot_brand_from_alias() from public, anon, authenticated;

insert into public.project_versions (workspace_id, project_id, version, configuration, configuration_hash, created_by)
select p.workspace_id, p.id, 1,
  jsonb_build_object('name', p.name, 'domain', p.domain, 'category', p.category,
    'default_market', p.default_market, 'default_locale', p.default_locale,
    'languages', to_jsonb(p.languages), 'status', p.status),
  encode(digest(jsonb_build_object('name', p.name, 'domain', p.domain, 'category', p.category,
    'default_market', p.default_market, 'default_locale', p.default_locale,
    'languages', to_jsonb(p.languages), 'status', p.status)::text, 'sha256'), 'hex'),
  p.created_by
from public.projects p
on conflict (project_id, version) do nothing;

insert into public.brand_versions (workspace_id, project_id, brand_id, version, name, domain, role, aliases, snapshot_hash)
select b.workspace_id, b.project_id, b.id, 1, b.name, b.domain, b.role, '[]'::jsonb,
  encode(digest(concat_ws('|', b.name, b.domain, b.role::text, '[]'), 'sha256'), 'hex')
from public.brands b
on conflict (brand_id, version) do nothing;

create trigger snapshot_project_version
after insert or update of name, domain, category, default_market, default_locale, languages, status
on public.projects for each row execute procedure private.snapshot_project_version();
create trigger bump_question_version
before update on public.questions for each row execute procedure private.bump_question_version();
create trigger snapshot_question_version
after insert or update of current_prompt, question_type, persona, stage, market, rationale, state
on public.questions for each row execute procedure private.snapshot_question_version();
create trigger snapshot_brand_version
after insert or update of name, domain, role
on public.brands for each row execute procedure private.snapshot_brand_version();
create trigger snapshot_brand_from_alias
after insert or update or delete on public.brand_aliases
for each row execute procedure private.snapshot_brand_from_alias();

-- Evidence lineage. A source is mutable configuration; each source version is
-- immutable retrieved content with independent retrieval/quote/export policy.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  kind public.source_kind not null,
  name text not null check (char_length(trim(name)) between 1 and 240),
  original_url text,
  canonical_url text,
  state public.source_state not null default 'active',
  retrieval_allowed boolean not null default true,
  quoting_allowed boolean not null default true,
  export_allowed boolean not null default true,
  authority_weight numeric(5,4) check (authority_weight between 0 and 1),
  freshness_days integer check (freshness_days is null or freshness_days > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id)
);
create table public.source_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  source_id uuid not null,
  version integer not null check (version > 0),
  content_text text,
  storage_path text,
  content_hash text not null,
  mime_type text,
  retrieved_at timestamptz,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  retrieval_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(retrieval_metadata) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint source_version_content check (content_text is not null or storage_path is not null),
  foreign key (source_id, project_id, workspace_id)
    references public.sources(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (source_id, version),
  unique (source_id, content_hash)
);
create table public.source_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  source_version_id uuid not null,
  claim_text text not null,
  evidence_excerpt text,
  freshness_state text not null default 'current' check (freshness_state in ('current', 'stale', 'unknown')),
  conflict_group text,
  created_at timestamptz not null default now(),
  foreign key (source_version_id, project_id, workspace_id)
    references public.source_versions(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id)
);

-- Execution ledger. Runs reference frozen project/question/brand cohorts.
alter table public.monitoring_runs rename to runs;
alter table public.runs add column project_id uuid;
alter table public.runs add column project_version_id uuid;
alter table public.runs add column question_set_id uuid;
alter table public.runs add column idempotency_key text;
alter table public.runs add column requested_capture_count integer not null default 0 check (requested_capture_count >= 0);
alter table public.runs add column estimated_max_cost_usd numeric(14,6) check (estimated_max_cost_usd is null or estimated_max_cost_usd >= 0);
alter table public.runs add column cancelled_at timestamptz;
alter table public.runs add column cancellation_reason text;
update public.runs r
set project_id = (select p.id from public.projects p where p.workspace_id = r.workspace_id order by p.created_at limit 1)
where r.project_id is null;
alter table public.runs alter column project_id set not null;
alter table public.runs
  add constraint runs_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade;
alter table public.runs add constraint runs_id_project_workspace_unique unique (id, project_id, workspace_id);
alter table public.runs drop constraint if exists monitoring_runs_requested_by_fkey;
alter table public.runs
  add constraint runs_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
create unique index runs_workspace_idempotency_idx
  on public.runs(workspace_id, idempotency_key) where idempotency_key is not null;

create table public.run_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  run_id uuid not null,
  question_version_id uuid not null,
  provider public.provider_key not null,
  locale text not null,
  market text not null,
  status public.job_status not null default 'queued',
  idempotency_key text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (run_id, project_id, workspace_id)
    references public.runs(id, project_id, workspace_id) on delete cascade,
  foreign key (question_version_id, project_id, workspace_id)
    references public.question_versions(id, project_id, workspace_id) on delete restrict,
  unique (id, project_id, workspace_id),
  unique (workspace_id, idempotency_key),
  unique (run_id, question_version_id, provider, locale, market)
);
create index run_items_claim_idx on public.run_items(status, available_at, lease_expires_at);

create table public.capture_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  run_item_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  status public.observation_status not null,
  access_method text not null check (access_method in ('api', 'search_api')),
  model_or_surface text not null,
  exact_prompt text not null,
  provider_request_id text,
  requested_at timestamptz not null,
  captured_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(14,6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  raw_response jsonb,
  answer_text text,
  error_code text,
  error_message text,
  retryable boolean not null default false,
  created_at timestamptz not null default now(),
  constraint capture_attempt_result check (
    (status = 'succeeded' and answer_text is not null and char_length(answer_text) > 0
      and raw_response is not null and captured_at is not null and error_message is null)
    or (status <> 'succeeded' and answer_text is null and error_code is not null)
  ),
  foreign key (run_item_id, project_id, workspace_id)
    references public.run_items(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (run_item_id, attempt_number)
);

alter table public.observations rename column buyer_decision_id to question_id;
alter table public.observations drop constraint if exists observations_run_id_buyer_decision_id_provider_key;
alter table public.observations drop constraint if exists observations_run_id_question_id_provider_key;
alter table public.observations add column project_id uuid;
alter table public.observations add column run_item_id uuid;
alter table public.observations add column capture_attempt_id uuid;
update public.observations o
set project_id = r.project_id
from public.runs r
where r.id = o.run_id and o.project_id is null;
alter table public.observations alter column project_id set not null;
alter table public.observations
  add constraint observations_run_project_workspace_fkey
  foreign key (run_id, project_id, workspace_id)
    references public.runs(id, project_id, workspace_id) on delete cascade;
alter table public.observations
  add constraint observations_question_project_workspace_fkey
  foreign key (question_id, project_id, workspace_id)
    references public.questions(id, project_id, workspace_id) on delete restrict;
alter table public.observations add constraint observations_id_project_workspace_unique unique (id, project_id, workspace_id);
alter table public.observations
  add constraint observations_run_item_project_workspace_fkey
  foreign key (run_item_id, project_id, workspace_id)
    references public.run_items(id, project_id, workspace_id) on delete restrict;
alter table public.observations
  add constraint observations_attempt_project_workspace_fkey
  foreign key (capture_attempt_id, project_id, workspace_id)
    references public.capture_attempts(id, project_id, workspace_id) on delete restrict;
create unique index observations_run_item_idx on public.observations(run_item_id) where run_item_id is not null;
create unique index observations_attempt_idx on public.observations(capture_attempt_id) where capture_attempt_id is not null;

alter table public.citations add column workspace_id uuid;
alter table public.citations add column project_id uuid;
alter table public.citations add column original_url text;
alter table public.citations add column canonical_url text;
alter table public.citations add column evidence_excerpt text;
update public.citations c
set workspace_id = o.workspace_id, project_id = o.project_id,
    original_url = coalesce(c.original_url, c.url), canonical_url = coalesce(c.canonical_url, c.url)
from public.observations o where o.id = c.observation_id;
alter table public.citations alter column workspace_id set not null;
alter table public.citations alter column project_id set not null;
alter table public.citations alter column original_url set not null;
alter table public.citations alter column canonical_url set not null;
alter table public.citations
  add constraint citations_observation_project_workspace_fkey
  foreign key (observation_id, project_id, workspace_id)
    references public.observations(id, project_id, workspace_id) on delete cascade;

-- Independent, versioned classification truth and human review.
create table public.classification_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  observation_id uuid not null,
  classifier_name text not null,
  classifier_version text not null,
  input_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (observation_id, project_id, workspace_id)
    references public.observations(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (observation_id, classifier_name, classifier_version, input_hash)
);
create table public.brand_classifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  classification_run_id uuid not null,
  observation_id uuid not null,
  brand_version_id uuid not null,
  mentioned boolean not null,
  cited boolean not null,
  shortlisted boolean not null default false,
  explicitly_recommended boolean not null,
  first_choice boolean not null,
  rejected boolean not null,
  rank integer check (rank is null or rank > 0),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  evidence_spans jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_spans) = 'array'),
  rationale text not null,
  review_status public.review_status not null default 'not_required',
  created_at timestamptz not null default now(),
  constraint classification_implications check (
    (not first_choice or explicitly_recommended)
    and (not explicitly_recommended or mentioned)
    and (not shortlisted or mentioned)
  ),
  foreign key (classification_run_id, project_id, workspace_id)
    references public.classification_runs(id, project_id, workspace_id) on delete cascade,
  foreign key (observation_id, project_id, workspace_id)
    references public.observations(id, project_id, workspace_id) on delete cascade,
  foreign key (brand_version_id, project_id, workspace_id)
    references public.brand_versions(id, project_id, workspace_id) on delete restrict,
  unique (id, project_id, workspace_id),
  unique (classification_run_id, brand_version_id)
);
create table public.classification_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  classification_id uuid not null,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision public.review_status not null check (decision in ('approved', 'overridden')),
  reason text not null check (char_length(trim(reason)) >= 3),
  before_value jsonb not null check (jsonb_typeof(before_value) = 'object'),
  after_value jsonb not null check (jsonb_typeof(after_value) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (classification_id, project_id, workspace_id)
    references public.brand_classifications(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id)
);

-- Deterministic metric snapshots retain formulas, cohorts, and record lineage.
create table public.metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  run_id uuid,
  metric_version text not null,
  cohort jsonb not null check (jsonb_typeof(cohort) = 'object'),
  coverage_numerator integer not null default 0,
  coverage_denominator integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  foreign key (run_id, project_id, workspace_id) references public.runs(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id)
);
create table public.metric_values (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  metric_snapshot_id uuid not null,
  metric_key text not null check (metric_key in (
    'capture_coverage', 'mention_rate', 'mention_share', 'recommendation_rate',
    'recommendation_share', 'first_choice_rate', 'owned_citation_rate', 'evidence_support_rate'
  )),
  numerator numeric not null check (numerator >= 0),
  denominator numeric not null check (denominator >= 0),
  value numeric generated always as (
    case when denominator = 0 then null else numerator / denominator end
  ) stored,
  created_at timestamptz not null default now(),
  foreign key (metric_snapshot_id, project_id, workspace_id)
    references public.metric_snapshots(id, project_id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id),
  unique (metric_snapshot_id, metric_key)
);
create table public.metric_capture_links (
  workspace_id uuid not null,
  project_id uuid not null,
  metric_value_id uuid not null,
  observation_id uuid not null,
  included boolean not null,
  exclusion_reason text,
  primary key (metric_value_id, observation_id),
  foreign key (metric_value_id, project_id, workspace_id)
    references public.metric_values(id, project_id, workspace_id) on delete cascade,
  foreign key (observation_id, project_id, workspace_id)
    references public.observations(id, project_id, workspace_id) on delete cascade,
  constraint excluded_metric_reason check (included or exclusion_reason is not null)
);

-- Improvement, scheduling, usage, API, webhook, and audit operations.
create table public.actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  title text not null,
  description text not null,
  status public.action_status not null default 'proposed',
  expected_impact text,
  effort text,
  uncertainty text,
  created_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  unique (id, project_id, workspace_id)
);
create table public.action_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  action_id uuid not null,
  question_version_id uuid,
  classification_id uuid,
  source_version_id uuid,
  rationale text not null,
  created_at timestamptz not null default now(),
  foreign key (action_id, project_id, workspace_id)
    references public.actions(id, project_id, workspace_id) on delete cascade,
  foreign key (question_version_id, project_id, workspace_id)
    references public.question_versions(id, project_id, workspace_id) on delete restrict,
  foreign key (classification_id, project_id, workspace_id)
    references public.brand_classifications(id, project_id, workspace_id) on delete restrict,
  foreign key (source_version_id, project_id, workspace_id)
    references public.source_versions(id, project_id, workspace_id) on delete restrict,
  constraint action_link_target check (num_nonnulls(question_version_id, classification_id, source_version_id) > 0),
  unique nulls not distinct (action_id, question_version_id, classification_id, source_version_id)
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  question_set_id uuid,
  providers public.provider_key[] not null default array['openai', 'claude', 'google_ai_overview']::public.provider_key[],
  name text not null,
  frequency public.schedule_frequency not null,
  timezone text not null,
  local_time time not null,
  weekday smallint check (weekday between 0 and 6),
  month_day smallint check (month_day between 1 and 28),
  overlap_policy public.overlap_policy not null default 'skip',
  failure_threshold integer not null default 3 check (failure_threshold between 1 and 20),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  circuit_opened_at timestamptz,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  foreign key (question_set_id, project_id, workspace_id)
    references public.question_sets(id, project_id, workspace_id) on delete restrict,
  unique (id, project_id, workspace_id),
  unique (project_id, name)
);

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider public.provider_key not null,
  display_name text not null,
  credential_ciphertext bytea,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  enabled boolean not null default true,
  health_state text not null default 'unchecked' check (health_state in ('unchecked', 'healthy', 'degraded', 'unavailable')),
  remediation text,
  last_checked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  run_id uuid,
  run_item_id uuid,
  capture_attempt_id uuid,
  provider public.provider_key,
  call_count integer not null default 0 check (call_count >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(14,6) not null default 0 check (estimated_cost_usd >= 0),
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  foreign key (project_id, workspace_id) references public.projects(id, workspace_id) on delete cascade,
  foreign key (run_id, project_id, workspace_id) references public.runs(id, project_id, workspace_id) on delete restrict,
  foreign key (run_item_id, project_id, workspace_id) references public.run_items(id, project_id, workspace_id) on delete restrict,
  foreign key (capture_attempt_id, project_id, workspace_id) references public.capture_attempts(id, project_id, workspace_id) on delete restrict,
  unique (workspace_id, idempotency_key)
);

create table public.workspace_quotas (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  monthly_call_limit integer not null default 1000 check (monthly_call_limit >= 0),
  monthly_cost_limit_usd numeric(14,2) not null default 100 check (monthly_cost_limit_usd >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  token_prefix text not null,
  token_hash text not null unique,
  scopes text[] not null default array['read']::text[],
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, name)
);

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  endpoint_url text not null check (endpoint_url ~ '^https://'),
  secret_ciphertext bytea not null,
  event_names text[] not null,
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, name)
);
create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  webhook_endpoint_id uuid not null,
  event_id uuid not null,
  event_name text not null,
  payload jsonb not null,
  status public.webhook_delivery_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  response_status integer,
  response_excerpt text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (webhook_endpoint_id, workspace_id)
    references public.webhook_endpoints(id, workspace_id) on delete cascade,
  unique (webhook_endpoint_id, event_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_token_id uuid,
  request_id text,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now(),
  foreign key (actor_token_id, workspace_id)
    references public.api_tokens(id, workspace_id) on delete set null (actor_token_id)
);
create index audit_events_workspace_time_idx on public.audit_events(workspace_id, occurred_at desc);

-- Atomic worker RPCs run as SECURITY INVOKER. They are callable only by the
-- service role, so no public function acquires definer/bypass privileges.
create or replace function public.lease_capture_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns setof public.run_items
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(trim(p_worker_id), '') is null or p_limit not between 1 and 100
    or p_lease_seconds not between 15 and 3600 then
    raise exception using errcode = '22023', message = 'Invalid lease request.';
  end if;
  return query
  with candidates as (
    select ri.id
    from public.run_items ri
    join public.runs r on r.id = ri.run_id
      and r.project_id = ri.project_id and r.workspace_id = ri.workspace_id
    where ri.status = 'queued'
      and ri.available_at <= now()
      and ri.attempt_count < ri.max_attempts
      and r.cancelled_at is null
    order by ri.available_at, ri.created_at
    for update of ri skip locked
    limit p_limit
  ), leased as (
    update public.run_items ri
    set status = 'leased', lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = ri.attempt_count + 1,
        started_at = coalesce(ri.started_at, now())
    from candidates c
    where ri.id = c.id
    returning ri.*
  )
  select * from leased;

  update public.runs r set status = 'running', started_at = coalesce(r.started_at, now())
  where r.id in (
    select ri.run_id from public.run_items ri
    where ri.lease_owner = p_worker_id and ri.status = 'leased'
  ) and r.status = 'queued';
end;
$$;

create or replace function public.complete_capture_job(
  p_job_id uuid,
  p_worker_id text,
  p_access_method text,
  p_model_or_surface text,
  p_exact_prompt text,
  p_provider_request_id text,
  p_captured_at timestamptz,
  p_latency_ms integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_estimated_cost_usd numeric,
  p_raw_response jsonb,
  p_answer_text text,
  p_citations jsonb default '[]'::jsonb,
  p_classifications jsonb default '[]'::jsonb,
  p_classifier_name text default null,
  p_classifier_version text default null,
  p_classifier_input_hash text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.run_items%rowtype;
  question_id_value uuid;
  attempt_id_value uuid;
  observation_id_value uuid;
  classification_run_id_value uuid;
  item jsonb;
begin
  select * into job from public.run_items where id = p_job_id for update;
  if not found or job.status <> 'leased' or job.lease_owner <> p_worker_id
    or job.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'Capture job is not leased by this worker.';
  end if;
  select qv.question_id into question_id_value
  from public.question_versions qv
  where qv.id = job.question_version_id and qv.project_id = job.project_id
    and qv.workspace_id = job.workspace_id;
  if question_id_value is null then
    raise exception using errcode = '23503', message = 'Question version is outside the job workspace.';
  end if;

  insert into public.capture_attempts (
    workspace_id, project_id, run_item_id, attempt_number, status, access_method,
    model_or_surface, exact_prompt, provider_request_id, requested_at, captured_at,
    latency_ms, input_tokens, output_tokens, estimated_cost_usd, raw_response, answer_text
  ) values (
    job.workspace_id, job.project_id, job.id, job.attempt_count, 'succeeded',
    p_access_method, p_model_or_surface, p_exact_prompt, p_provider_request_id,
    coalesce(job.started_at, now()), p_captured_at, p_latency_ms, p_input_tokens,
    p_output_tokens, p_estimated_cost_usd, p_raw_response, p_answer_text
  ) returning id into attempt_id_value;

  insert into public.observations (
    workspace_id, project_id, run_id, question_id, provider, status, access_method,
    model_or_surface, provider_request_id, captured_at, raw_response, answer_text,
    run_item_id, capture_attempt_id
  ) values (
    job.workspace_id, job.project_id, job.run_id, question_id_value, job.provider,
    'succeeded', p_access_method, p_model_or_surface, p_provider_request_id,
    p_captured_at, p_raw_response, p_answer_text, job.id, attempt_id_value
  ) returning id into observation_id_value;

  for item in select value from jsonb_array_elements(coalesce(p_citations, '[]'::jsonb)) loop
    insert into public.citations (
      workspace_id, project_id, observation_id, url, original_url, canonical_url,
      title, position, evidence_excerpt
    ) values (
      job.workspace_id, job.project_id, observation_id_value,
      item->>'url', coalesce(item->>'originalUrl', item->>'url'),
      coalesce(item->>'canonicalUrl', item->>'url'), item->>'title',
      nullif(item->>'position', '')::integer, item->>'evidenceExcerpt'
    ) on conflict (observation_id, url) do nothing;
  end loop;

  if jsonb_array_length(coalesce(p_classifications, '[]'::jsonb)) > 0 then
    if p_classifier_name is null or p_classifier_version is null or p_classifier_input_hash is null then
      raise exception using errcode = '22023', message = 'Classifier identity is required with classifications.';
    end if;
    insert into public.classification_runs (
      workspace_id, project_id, observation_id, classifier_name, classifier_version, input_hash
    ) values (
      job.workspace_id, job.project_id, observation_id_value,
      p_classifier_name, p_classifier_version, p_classifier_input_hash
    ) returning id into classification_run_id_value;

    for item in select value from jsonb_array_elements(p_classifications) loop
      insert into public.brand_classifications (
        workspace_id, project_id, classification_run_id, observation_id,
        brand_version_id, mentioned, cited, shortlisted, explicitly_recommended,
        first_choice, rejected, rank, confidence, evidence_spans, rationale, review_status
      ) values (
        job.workspace_id, job.project_id, classification_run_id_value, observation_id_value,
        (item->>'brandVersionId')::uuid, coalesce((item->>'mentioned')::boolean, false),
        coalesce((item->>'cited')::boolean, false), coalesce((item->>'shortlisted')::boolean, false),
        coalesce((item->>'explicitlyRecommended')::boolean, false),
        coalesce((item->>'firstChoice')::boolean, false), coalesce((item->>'rejected')::boolean, false),
        nullif(item->>'rank', '')::integer, coalesce((item->>'confidence')::numeric, 0),
        coalesce(item->'evidenceSpans', '[]'::jsonb), coalesce(item->>'rationale', ''),
        case when coalesce((item->>'requiresReview')::boolean, false)
          then 'pending'::public.review_status else 'not_required'::public.review_status end
      );
    end loop;
  end if;

  insert into public.usage_events (
    workspace_id, project_id, run_id, run_item_id, capture_attempt_id, provider,
    call_count, input_tokens, output_tokens, estimated_cost_usd, idempotency_key
  ) values (
    job.workspace_id, job.project_id, job.run_id, job.id, attempt_id_value, job.provider,
    1, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_estimated_cost_usd, 0), 'capture:' || attempt_id_value::text
  );

  update public.run_items set status = 'succeeded', completed_at = now(),
    lease_owner = null, lease_expires_at = null, last_error_code = null
  where id = job.id;
  update public.runs r set
    status = case
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')) then r.status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded')
        and exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('failed', 'unavailable', 'cancelled')) then 'partial'::public.run_status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded') then 'succeeded'::public.run_status
      else 'failed'::public.run_status
    end,
    completed_at = case when not exists (
      select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')
    ) then now() else r.completed_at end
  where r.id = job.run_id;
  return observation_id_value;
end;
$$;

create or replace function public.fail_capture_job(
  p_job_id uuid,
  p_worker_id text,
  p_status public.observation_status,
  p_access_method text,
  p_model_or_surface text,
  p_exact_prompt text,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_retry_at timestamptz default null
)
returns public.job_status
language plpgsql
security invoker
set search_path = ''
as $$
declare
  job public.run_items%rowtype;
  next_status public.job_status;
begin
  if p_status = 'succeeded' or nullif(trim(p_error_code), '') is null then
    raise exception using errcode = '22023', message = 'Failure status and code are required.';
  end if;
  select * into job from public.run_items where id = p_job_id for update;
  if not found or job.status <> 'leased' or job.lease_owner <> p_worker_id then
    raise exception using errcode = '55000', message = 'Capture job is not leased by this worker.';
  end if;
  insert into public.capture_attempts (
    workspace_id, project_id, run_item_id, attempt_number, status, access_method,
    model_or_surface, exact_prompt, requested_at, captured_at, error_code,
    error_message, retryable
  ) values (
    job.workspace_id, job.project_id, job.id, job.attempt_count, p_status,
    p_access_method, p_model_or_surface, p_exact_prompt, coalesce(job.started_at, now()),
    now(), p_error_code, p_error_message, p_retryable
  );
  next_status := case
    when p_retryable and job.attempt_count < job.max_attempts then 'queued'::public.job_status
    when p_status = 'unavailable' then 'unavailable'::public.job_status
    else 'failed'::public.job_status
  end;
  update public.run_items set status = next_status, lease_owner = null,
    lease_expires_at = null, last_error_code = p_error_code,
    available_at = case when next_status = 'queued' then coalesce(p_retry_at, now()) else available_at end,
    completed_at = case when next_status in ('failed', 'unavailable') then now() else completed_at end
  where id = job.id;
  if next_status <> 'queued' then
    update public.runs r set
      status = case
        when exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')) then r.status
        when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded') then 'partial'::public.run_status
        else 'failed'::public.run_status
      end,
      completed_at = case when not exists (
        select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')
      ) then now() else r.completed_at end
    where r.id = job.run_id;
  end if;
  return next_status;
end;
$$;

create or replace function public.recover_expired_capture_leases(p_now timestamptz default now())
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  recovered integer;
  affected_run_ids uuid[];
begin
  select coalesce(array_agg(distinct ri.run_id), '{}'::uuid[]) into affected_run_ids
  from public.run_items ri where ri.status = 'leased' and ri.lease_expires_at < p_now;
  update public.run_items set
    status = case when attempt_count < max_attempts then 'queued'::public.job_status else 'failed'::public.job_status end,
    lease_owner = null, lease_expires_at = null,
    available_at = p_now, last_error_code = 'lease_expired',
    completed_at = case when attempt_count >= max_attempts then p_now else completed_at end
  where status = 'leased' and lease_expires_at < p_now;
  get diagnostics recovered = row_count;
  update public.runs r set
    status = case
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')) then r.status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded')
        and exists (select 1 from public.run_items x where x.run_id = r.id and x.status in ('failed', 'unavailable', 'cancelled')) then 'partial'::public.run_status
      when exists (select 1 from public.run_items x where x.run_id = r.id and x.status = 'succeeded') then 'succeeded'::public.run_status
      else 'failed'::public.run_status
    end,
    completed_at = case when not exists (
      select 1 from public.run_items x where x.run_id = r.id and x.status in ('queued', 'leased')
    ) then p_now else r.completed_at end
  where r.id = any(affected_run_ids);
  return recovered;
end;
$$;

create or replace function public.enqueue_due_schedules(p_now timestamptz default now())
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  schedule_row public.schedules%rowtype;
  run_id_value uuid;
  created_count integer := 0;
begin
  for schedule_row in
    select * from public.schedules s
    where s.enabled and s.circuit_opened_at is null and s.next_run_at <= p_now
      and s.question_set_id is not null
    order by s.next_run_at
    for update skip locked
  loop
    insert into public.runs (
      workspace_id, project_id, question_set_id, status, requested_by,
      idempotency_key, requested_capture_count
    ) values (
      schedule_row.workspace_id, schedule_row.project_id, schedule_row.question_set_id,
      'queued', schedule_row.created_by,
      'schedule:' || schedule_row.id::text || ':' || schedule_row.next_run_at::text,
      (select count(*) from public.question_set_items qsi
       where qsi.question_set_id = schedule_row.question_set_id) * cardinality(schedule_row.providers)
    ) on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
    returning id into run_id_value;
    if run_id_value is not null then
      insert into public.run_items (
        workspace_id, project_id, run_id, question_version_id, provider,
        locale, market, idempotency_key
      )
      select schedule_row.workspace_id, schedule_row.project_id, run_id_value,
        qsi.question_version_id, provider_value, qv.locale, qv.market,
        'schedule-item:' || run_id_value::text || ':' || qsi.question_version_id::text || ':' || provider_value::text
      from public.question_set_items qsi
      join public.question_versions qv on qv.id = qsi.question_version_id
        and qv.project_id = schedule_row.project_id and qv.workspace_id = schedule_row.workspace_id
      cross join unnest(schedule_row.providers) as provider_list(provider_value)
      where qsi.question_set_id = schedule_row.question_set_id;
      created_count := created_count + 1;
    end if;
    update public.schedules set last_run_at = p_now,
      next_run_at = case schedule_row.frequency
        when 'daily' then schedule_row.next_run_at + interval '1 day'
        when 'weekly' then schedule_row.next_run_at + interval '1 week'
        when 'monthly' then schedule_row.next_run_at + interval '1 month'
      end
    where id = schedule_row.id;
    run_id_value := null;
  end loop;
  return created_count;
end;
$$;

create or replace function public.create_monitoring_run(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_question_version_ids uuid[],
  p_providers public.provider_key[],
  p_idempotency_key text,
  p_estimated_max_cost_usd numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_id_value uuid;
  question_row record;
  provider_value public.provider_key;
  actor_role public.workspace_role;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot request runs in this workspace.';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if cardinality(p_question_version_ids) is null or cardinality(p_question_version_ids) = 0
    or cardinality(p_providers) is null or cardinality(p_providers) = 0 then
    raise exception using errcode = '22023', message = 'At least one question and provider are required.';
  end if;
  if exists (
    select 1 from unnest(p_question_version_ids) id
    where not exists (
      select 1 from public.question_versions qv
      where qv.id = id and qv.project_id = p_project_id and qv.workspace_id = p_workspace_id
    )
  ) then
    raise exception using errcode = '23503', message = 'Question version is outside the requested project.';
  end if;

  insert into public.runs (
    workspace_id, project_id, status, requested_by, idempotency_key,
    requested_capture_count, estimated_max_cost_usd
  ) values (
    p_workspace_id, p_project_id, 'queued', p_actor_id, p_idempotency_key,
    cardinality(p_question_version_ids) * cardinality(p_providers), p_estimated_max_cost_usd
  ) on conflict (workspace_id, idempotency_key) where idempotency_key is not null
    do update set idempotency_key = excluded.idempotency_key
  returning id into run_id_value;

  for question_row in
    select qv.id, qv.locale, qv.market from public.question_versions qv
    where qv.id = any(p_question_version_ids) and qv.project_id = p_project_id
      and qv.workspace_id = p_workspace_id
  loop
    foreach provider_value in array p_providers loop
      insert into public.run_items (
        workspace_id, project_id, run_id, question_version_id, provider,
        locale, market, idempotency_key
      ) values (
        p_workspace_id, p_project_id, run_id_value, question_row.id, provider_value,
        question_row.locale, question_row.market,
        'manual-item:' || run_id_value::text || ':' || question_row.id::text || ':' || provider_value::text
      ) on conflict (workspace_id, idempotency_key) do nothing;
    end loop;
  end loop;
  return run_id_value;
end;
$$;

revoke all on function public.lease_capture_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_capture_job(uuid, text, text, text, text, text, timestamptz, integer, integer, integer, numeric, jsonb, text, jsonb, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_capture_job(uuid, text, public.observation_status, text, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.recover_expired_capture_leases(timestamptz) from public, anon, authenticated;
revoke all on function public.enqueue_due_schedules(timestamptz) from public, anon, authenticated;
revoke all on function public.create_monitoring_run(uuid, uuid, uuid, uuid[], public.provider_key[], text, numeric) from public, anon, authenticated;
grant execute on function public.lease_capture_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_capture_job(uuid, text, text, text, text, text, timestamptz, integer, integer, integer, numeric, jsonb, text, jsonb, jsonb, text, text, text) to service_role;
grant execute on function public.fail_capture_job(uuid, text, public.observation_status, text, text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.recover_expired_capture_leases(timestamptz) to service_role;
grant execute on function public.enqueue_due_schedules(timestamptz) to service_role;
grant execute on function public.create_monitoring_run(uuid, uuid, uuid, uuid[], public.provider_key[], text, numeric) to service_role;

-- Updated-at and immutable-ledger triggers.
drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at before update on public.projects
for each row execute procedure private.set_updated_at();
drop trigger if exists set_brands_updated_at on public.brands;
create trigger set_brands_updated_at before update on public.brands
for each row execute procedure private.set_updated_at();
drop trigger if exists set_questions_updated_at on public.questions;
create trigger set_questions_updated_at before update on public.questions
for each row execute procedure private.set_updated_at();
drop trigger if exists set_sources_updated_at on public.sources;
create trigger set_sources_updated_at before update on public.sources
for each row execute procedure private.set_updated_at();
drop trigger if exists set_actions_updated_at on public.actions;
create trigger set_actions_updated_at before update on public.actions
for each row execute procedure private.set_updated_at();
drop trigger if exists set_schedules_updated_at on public.schedules;
create trigger set_schedules_updated_at before update on public.schedules
for each row execute procedure private.set_updated_at();
drop trigger if exists set_provider_connections_updated_at on public.provider_connections;
create trigger set_provider_connections_updated_at before update on public.provider_connections
for each row execute procedure private.set_updated_at();
drop trigger if exists set_webhook_endpoints_updated_at on public.webhook_endpoints;
create trigger set_webhook_endpoints_updated_at before update on public.webhook_endpoints
for each row execute procedure private.set_updated_at();

create trigger immutable_project_versions before update on public.project_versions
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_brand_versions before update on public.brand_versions
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_question_versions before update on public.question_versions
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_source_versions before update on public.source_versions
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_observations before update on public.observations
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_classification_runs before update on public.classification_runs
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_brand_classifications before update on public.brand_classifications
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_classification_reviews before update on public.classification_reviews
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_metric_snapshots before update on public.metric_snapshots
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_metric_values before update on public.metric_values
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_usage_events before update on public.usage_events
for each row execute procedure private.prevent_immutable_mutation();
create trigger immutable_audit_events before update on public.audit_events
for each row execute procedure private.prevent_immutable_mutation();

-- Enable RLS on every exposed table.
alter table public.workspace_invitations enable row level security;
alter table public.projects enable row level security;
alter table public.brand_aliases enable row level security;
alter table public.brand_versions enable row level security;
alter table public.question_versions enable row level security;
alter table public.question_sets enable row level security;
alter table public.question_set_items enable row level security;
alter table public.project_versions enable row level security;
alter table public.sources enable row level security;
alter table public.source_versions enable row level security;
alter table public.source_claims enable row level security;
alter table public.run_items enable row level security;
alter table public.capture_attempts enable row level security;
alter table public.classification_runs enable row level security;
alter table public.brand_classifications enable row level security;
alter table public.classification_reviews enable row level security;
alter table public.metric_snapshots enable row level security;
alter table public.metric_values enable row level security;
alter table public.metric_capture_links enable row level security;
alter table public.actions enable row level security;
alter table public.action_links enable row level security;
alter table public.schedules enable row level security;
alter table public.provider_connections enable row level security;
alter table public.usage_events enable row level security;
alter table public.workspace_quotas enable row level security;
alter table public.api_tokens enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.audit_events enable row level security;

-- Replace legacy policies whose role contract changed.
drop policy if exists "editors can create brands" on public.brands;
drop policy if exists "editors can update brands" on public.brands;
drop policy if exists "editors can delete brands" on public.brands;
drop policy if exists "members can read decisions" on public.questions;
drop policy if exists "editors can create decisions" on public.questions;
drop policy if exists "editors can update decisions" on public.questions;
drop policy if exists "editors can delete decisions" on public.questions;
drop policy if exists "members can read runs" on public.runs;
drop policy if exists "editors can request runs" on public.runs;

create policy workspaces_update_admin on public.workspaces for update to authenticated
using (private.has_workspace_role(id, 'admin'))
with check (private.has_workspace_role(id, 'admin'));
create policy workspaces_delete_owner on public.workspaces for delete to authenticated
using (private.has_workspace_role(id, 'owner'));

create policy workspace_members_update_admin on public.workspace_members for update to authenticated
using (
  user_id <> (select auth.uid())
  and (
    private.has_workspace_role(workspace_id, 'owner')
    or (private.has_workspace_role(workspace_id, 'admin') and role <> 'owner')
  )
)
with check (
  private.has_workspace_role(workspace_id, 'owner')
  or (private.has_workspace_role(workspace_id, 'admin') and role <> 'owner')
);
create policy workspace_members_delete_admin on public.workspace_members for delete to authenticated
using (
  user_id <> (select auth.uid())
  and (
    private.has_workspace_role(workspace_id, 'owner')
    or (private.has_workspace_role(workspace_id, 'admin') and role <> 'owner')
  )
);

create policy invitations_read on public.workspace_invitations for select to authenticated
using (
  private.has_workspace_role(workspace_id, 'admin')
  or invited_user_id = (select auth.uid())
);
create policy invitations_accept on public.workspace_invitations for update to authenticated
using (
  invitation_kind = 'workspace'
  and workspace_id is not null
  and
  invited_user_id = (select auth.uid())
  and accepted_at is null
  and revoked_at is null
  and expires_at > now()
)
with check (
  invitation_kind = 'workspace'
  and workspace_id is not null
  and
  invited_user_id = (select auth.uid())
  and accepted_at is not null
  and revoked_at is null
);

-- Reusable policy pattern: members read; analysts edit product records.
create policy projects_read on public.projects for select to authenticated using (private.is_workspace_member(workspace_id));
create policy projects_insert on public.projects for insert to authenticated
with check (private.has_workspace_role(workspace_id, 'analyst') and created_by = (select auth.uid()));
create policy projects_update on public.projects for update to authenticated
using (private.has_workspace_role(workspace_id, 'analyst')) with check (private.has_workspace_role(workspace_id, 'analyst'));
create policy projects_delete on public.projects for delete to authenticated using (private.has_workspace_role(workspace_id, 'admin'));

create policy brands_insert on public.brands for insert to authenticated with check (private.has_workspace_role(workspace_id, 'analyst'));
create policy brands_update on public.brands for update to authenticated using (private.has_workspace_role(workspace_id, 'analyst')) with check (private.has_workspace_role(workspace_id, 'analyst'));
create policy brands_delete on public.brands for delete to authenticated using (private.has_workspace_role(workspace_id, 'analyst'));
create policy questions_read on public.questions for select to authenticated using (private.is_workspace_member(workspace_id));
create policy questions_insert on public.questions for insert to authenticated with check (private.has_workspace_role(workspace_id, 'analyst') and created_by = (select auth.uid()));
create policy questions_update on public.questions for update to authenticated using (private.has_workspace_role(workspace_id, 'analyst')) with check (private.has_workspace_role(workspace_id, 'analyst'));
create policy questions_delete on public.questions for delete to authenticated using (private.has_workspace_role(workspace_id, 'analyst'));
create policy runs_read on public.runs for select to authenticated using (private.is_workspace_member(workspace_id));
create policy runs_insert on public.runs for insert to authenticated with check (
  private.has_workspace_role(workspace_id, 'analyst')
  and requested_by = (select auth.uid())
  and status = 'queued'
);

-- Apply standard read/edit policies to product tables with direct workspace_id.
do $policies$
declare table_name text;
begin
  foreach table_name in array array[
    'brand_aliases', 'brand_versions', 'question_versions', 'question_sets',
    'question_set_items', 'project_versions', 'sources', 'source_versions',
    'source_claims', 'actions', 'action_links'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_workspace_member(workspace_id))', table_name || '_read', table_name);
    if table_name not in ('brand_versions', 'question_versions', 'project_versions') then
      execute format('create policy %I on public.%I for insert to authenticated with check (private.has_workspace_role(workspace_id, ''analyst''))', table_name || '_insert', table_name);
    end if;
    if table_name in ('brand_aliases', 'sources', 'actions') then
      execute format('create policy %I on public.%I for update to authenticated using (private.has_workspace_role(workspace_id, ''analyst'')) with check (private.has_workspace_role(workspace_id, ''analyst''))', table_name || '_update', table_name);
      execute format('create policy %I on public.%I for delete to authenticated using (private.has_workspace_role(workspace_id, ''analyst''))', table_name || '_delete', table_name);
    end if;
  end loop;
end
$policies$;

-- Runtime ledgers are readable by members and writable only by trusted server roles.
do $policies$
declare table_name text;
begin
  foreach table_name in array array[
    'run_items', 'capture_attempts', 'observations', 'citations',
    'classification_runs', 'brand_classifications', 'metric_snapshots',
    'metric_values', 'metric_capture_links', 'usage_events'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_workspace_member(workspace_id))', table_name || '_read', table_name);
  end loop;
end
$policies$;

create policy classification_reviews_read on public.classification_reviews for select to authenticated
using (private.is_workspace_member(workspace_id));
create policy classification_reviews_insert on public.classification_reviews for insert to authenticated
with check (private.has_workspace_role(workspace_id, 'analyst') and reviewer_id = (select auth.uid()));

create policy schedules_read on public.schedules for select to authenticated using (private.is_workspace_member(workspace_id));
create policy schedules_insert on public.schedules for insert to authenticated with check (private.has_workspace_role(workspace_id, 'admin'));
create policy schedules_update on public.schedules for update to authenticated using (private.has_workspace_role(workspace_id, 'admin')) with check (private.has_workspace_role(workspace_id, 'admin'));
create policy schedules_delete on public.schedules for delete to authenticated using (private.has_workspace_role(workspace_id, 'admin'));

create policy provider_connections_read on public.provider_connections for select to authenticated using (private.is_workspace_member(workspace_id));
create policy provider_connections_write on public.provider_connections for all to authenticated
using (private.has_workspace_role(workspace_id, 'admin')) with check (private.has_workspace_role(workspace_id, 'admin'));
create policy workspace_quotas_read on public.workspace_quotas for select to authenticated using (private.is_workspace_member(workspace_id));
create policy api_tokens_owner on public.api_tokens for select to authenticated using (private.has_workspace_role(workspace_id, 'owner'));
create policy webhook_endpoints_admin on public.webhook_endpoints for all to authenticated
using (private.has_workspace_role(workspace_id, 'admin')) with check (private.has_workspace_role(workspace_id, 'admin'));
create policy webhook_deliveries_admin on public.webhook_deliveries for select to authenticated using (private.has_workspace_role(workspace_id, 'admin'));
create policy audit_events_admin on public.audit_events for select to authenticated using (private.has_workspace_role(workspace_id, 'admin'));

-- Explicit Data API privileges. RLS still decides which rows are visible.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select, update (full_name) on public.profiles to authenticated;
-- Workspace creation is service-only through bootstrap_workspace_from_invitation;
-- this prevents an invited or existing account from bypassing owner bootstrap.
grant select, update (name, slug), delete on public.workspaces to authenticated;
grant select, update (role), delete on public.workspace_members to authenticated;
grant select on public.workspace_invitations to authenticated;
grant update (accepted_at) on public.workspace_invitations to authenticated;
grant select, insert, update, delete on public.projects, public.brands, public.brand_aliases, public.questions,
  public.sources, public.actions, public.schedules to authenticated;
grant select on public.brand_versions, public.question_versions, public.project_versions to authenticated;
grant select, insert on public.question_sets, public.question_set_items, public.source_versions, public.source_claims,
  public.runs, public.classification_reviews, public.action_links to authenticated;
grant select on public.run_items, public.capture_attempts, public.observations, public.citations,
  public.classification_runs, public.brand_classifications, public.metric_snapshots,
  public.metric_values, public.metric_capture_links, public.usage_events, public.workspace_quotas,
  public.webhook_deliveries, public.audit_events to authenticated;
grant select (id, workspace_id, provider, display_name, configuration, enabled, health_state, remediation, last_checked_at, created_by, created_at, updated_at)
  on public.provider_connections to authenticated;
grant insert (workspace_id, provider, display_name, configuration, enabled, created_by),
  update (display_name, configuration, enabled)
  on public.provider_connections to authenticated;
grant select (id, workspace_id, name, token_prefix, scopes, created_by, expires_at, last_used_at, revoked_at, created_at)
  on public.api_tokens to authenticated;
grant select (id, workspace_id, name, endpoint_url, event_names, enabled, created_by, created_at, updated_at),
  insert (workspace_id, name, endpoint_url, event_names, enabled, created_by),
  update (name, endpoint_url, event_names, enabled), delete
  on public.webhook_endpoints to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- No future public table/function silently inherits broad access.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- Useful indexes for tenant-filtered product queries.
create index projects_workspace_updated_idx on public.projects(workspace_id, updated_at desc);
create index brands_project_role_idx on public.brands(workspace_id, project_id, role);
create index questions_project_state_idx on public.questions(workspace_id, project_id, state, updated_at desc);
create index sources_project_state_idx on public.sources(workspace_id, project_id, state, updated_at desc);
create index runs_project_created_idx on public.runs(workspace_id, project_id, created_at desc);
create index observations_project_captured_idx on public.observations(workspace_id, project_id, captured_at desc);
create index reviews_workspace_status_idx on public.brand_classifications(workspace_id, review_status, created_at desc);
create index actions_project_status_idx on public.actions(workspace_id, project_id, status, updated_at desc);
create index usage_project_time_idx on public.usage_events(workspace_id, project_id, occurred_at desc);
