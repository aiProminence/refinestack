create extension if not exists pgcrypto;

create type public.workspace_role as enum ('owner', 'admin', 'analyst', 'viewer');
create type public.provider_key as enum ('openai', 'perplexity', 'google_ai_overview');
create type public.run_status as enum ('pending', 'running', 'completed', 'partial', 'failed');
create type public.observation_status as enum ('succeeded', 'failed', 'unavailable');
create type public.recommendation_kind as enum ('none', 'mentioned', 'recommended', 'first_choice');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  domain text not null,
  market text not null default 'en-MY',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, domain)
);
create unique index one_primary_brand_per_workspace on public.brands(workspace_id) where is_primary;

create table public.buyer_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  prompt text not null check (char_length(prompt) between 10 and 4000),
  market text not null default 'en-MY',
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.monitoring_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status public.run_status not null default 'pending',
  requested_by uuid references auth.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.monitoring_runs(id) on delete cascade,
  buyer_decision_id uuid not null references public.buyer_decisions(id) on delete cascade,
  provider public.provider_key not null,
  status public.observation_status not null,
  access_method text not null,
  model_or_surface text,
  provider_request_id text,
  captured_at timestamptz not null default now(),
  raw_response jsonb,
  answer_text text,
  error_code text,
  error_message text,
  constraint observation_result_consistency check (
    (status = 'succeeded' and answer_text is not null and error_message is null)
    or (status <> 'succeeded' and answer_text is null)
  ),
  unique (run_id, buyer_decision_id, provider)
);

create table public.citations (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.observations(id) on delete cascade,
  url text not null,
  title text,
  position integer check (position is null or position > 0),
  created_at timestamptz not null default now(),
  unique (observation_id, url)
);

create table public.brand_events (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.observations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  kind public.recommendation_kind not null,
  rank integer check (rank is null or rank > 0),
  evidence_excerpt text,
  classifier_version text not null,
  confidence numeric(4,3) check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  unique (observation_id, brand_id)
);

create index workspace_members_user_idx on public.workspace_members(user_id);
create index observations_workspace_captured_idx on public.observations(workspace_id, captured_at desc);
create index observations_run_idx on public.observations(run_id);
create index brand_events_observation_idx on public.brand_events(observation_id);

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_workspace(target_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
      and role in ('owner', 'admin', 'analyst')
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  workspace_id uuid;
  workspace_name text;
begin
  workspace_name := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1), 'My') || '''s workspace';
  insert into public.profiles (id, full_name) values (new.id, new.raw_user_meta_data ->> 'full_name');
  insert into public.workspaces (name, slug, created_by)
    values (workspace_name, 'workspace-' || substr(replace(new.id::text, '-', ''), 1, 12), new.id)
    returning id into workspace_id;
  insert into public.workspace_members (workspace_id, user_id, role) values (workspace_id, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.brands enable row level security;
alter table public.buyer_decisions enable row level security;
alter table public.monitoring_runs enable row level security;
alter table public.observations enable row level security;
alter table public.citations enable row level security;
alter table public.brand_events enable row level security;

create policy "profiles are self readable" on public.profiles for select using (id = auth.uid());
create policy "profiles are self editable" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "members can read workspaces" on public.workspaces for select using (public.is_workspace_member(id));
create policy "members can read memberships" on public.workspace_members for select using (public.is_workspace_member(workspace_id));
create policy "members can read brands" on public.brands for select using (public.is_workspace_member(workspace_id));
create policy "editors can create brands" on public.brands for insert with check (public.can_edit_workspace(workspace_id));
create policy "editors can update brands" on public.brands for update using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "editors can delete brands" on public.brands for delete using (public.can_edit_workspace(workspace_id));
create policy "members can read decisions" on public.buyer_decisions for select using (public.is_workspace_member(workspace_id));
create policy "editors can create decisions" on public.buyer_decisions for insert with check (
  public.can_edit_workspace(workspace_id) and created_by = auth.uid()
);
create policy "editors can update decisions" on public.buyer_decisions for update using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "editors can delete decisions" on public.buyer_decisions for delete using (public.can_edit_workspace(workspace_id));
create policy "members can read runs" on public.monitoring_runs for select using (public.is_workspace_member(workspace_id));
create policy "editors can request runs" on public.monitoring_runs for insert with check (
  public.can_edit_workspace(workspace_id) and requested_by = auth.uid() and status = 'pending'
);
create policy "members can read observations" on public.observations for select using (public.is_workspace_member(workspace_id));
create policy "members can read citations" on public.citations for select using (
  exists (select 1 from public.observations o where o.id = observation_id and public.is_workspace_member(o.workspace_id))
);
create policy "members can read brand events" on public.brand_events for select using (
  exists (select 1 from public.observations o where o.id = observation_id and public.is_workspace_member(o.workspace_id))
);

revoke all on function public.is_workspace_member(uuid) from public;
revoke all on function public.can_edit_workspace(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.can_edit_workspace(uuid) to authenticated;
