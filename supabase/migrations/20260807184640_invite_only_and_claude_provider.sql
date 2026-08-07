-- Align the provider model and enforce private-beta registration at the Auth boundary.
alter type public.provider_key rename value 'perplexity' to 'claude';

create table private.beta_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(trim(email))),
  full_name text,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index beta_invites_email_idx on private.beta_invites (lower(email));
alter table private.beta_invites enable row level security;

revoke all on table private.beta_invites from public, anon, authenticated;

create or replace function private.hook_require_beta_invite(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_email text := lower(trim(event->'user'->>'email'));
begin
  if signup_email is null or not exists (
    select 1
    from private.beta_invites
    where email = signup_email
      and accepted_at is null
      and (expires_at is null or expires_at > now())
  ) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'This private beta is invitation-only.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

revoke all on function private.hook_require_beta_invite(jsonb) from public, anon, authenticated;
grant execute on function private.hook_require_beta_invite(jsonb) to supabase_auth_admin;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  update private.beta_invites
    set accepted_at = now()
    where email = lower(trim(new.email)) and accepted_at is null;
  return new;
end;
$$;
