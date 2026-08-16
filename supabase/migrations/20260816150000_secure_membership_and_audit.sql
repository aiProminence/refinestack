-- Make mailbox verification authoritative at membership creation, reject stale
-- pre-verification sessions, repair question snapshot boundaries, and preserve
-- accurate audit attribution for service RPCs.

alter table public.workspace_members
  add column session_not_before timestamptz;

create or replace function private.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = (select auth.uid())
      and (
        wm.session_not_before is null
        or to_timestamp(coalesce((auth.jwt()->>'iat')::bigint, 0)) > wm.session_not_before
      )
  );
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
    and (
      wm.session_not_before is null
      or to_timestamp(coalesce((auth.jwt()->>'iat')::bigint, 0)) > wm.session_not_before
    )
  limit 1;
$$;

drop policy if exists invitations_accept on public.workspace_invitations;
revoke update (accepted_at) on public.workspace_invitations from authenticated;

create or replace function private.accept_workspace_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.accepted_at is null and new.accepted_at is not null and new.workspace_id is not null then
    if new.email_reverification_requested_at is null then
      raise exception using errcode = '23514', message = 'Fresh mailbox verification is required.';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role, session_not_before)
    values (new.workspace_id, new.invited_user_id, new.role, new.email_reverification_requested_at)
    on conflict (workspace_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.accept_workspace_invitation(
  p_invitation_id uuid,
  p_user_id uuid,
  p_verified_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
begin
  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found or invitation.invitation_kind <> 'workspace'
    or invitation.invited_user_id <> p_user_id or invitation.accepted_at is not null
    or invitation.revoked_at is not null or invitation.expires_at <= now()
    or invitation.email_reverification_requested_at is null
    or p_verified_at <= invitation.email_reverification_requested_at
    or p_verified_at > now() + interval '1 minute'
    or p_verified_at < now() - interval '15 minutes' then
    raise exception using errcode = '42501', message = 'Invitation verification is invalid or expired.';
  end if;
  perform set_config('app.actor_user_id', p_user_id::text, true);
  update public.workspace_invitations set accepted_at = now() where id = invitation.id;
  return invitation.workspace_id;
end;
$$;

revoke all on function public.accept_workspace_invitation(uuid, uuid, timestamptz)
from public, anon, authenticated;
grant execute on function public.accept_workspace_invitation(uuid, uuid, timestamptz)
to service_role;

drop function public.bootstrap_workspace_from_invitation(uuid, uuid, text, text);
create or replace function public.bootstrap_workspace_from_invitation(
  p_invitation_id uuid,
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_verified_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
  workspace_id_value uuid;
begin
  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found or invitation.invitation_kind <> 'bootstrap'
    or invitation.invited_user_id <> p_user_id or invitation.accepted_at is not null
    or invitation.revoked_at is not null or invitation.expires_at <= now()
    or invitation.email_reverification_requested_at is null
    or p_verified_at <= invitation.email_reverification_requested_at
    or p_verified_at > now() + interval '1 minute'
    or p_verified_at < now() - interval '15 minutes' then
    raise exception using errcode = '42501', message = 'Bootstrap invitation verification is invalid or expired.';
  end if;
  perform set_config('app.actor_user_id', p_user_id::text, true);
  insert into public.workspaces (name, slug, created_by)
  values (p_name, p_slug, p_user_id) returning id into workspace_id_value;
  update public.workspace_invitations set workspace_id = workspace_id_value, accepted_at = now()
  where id = invitation.id;
  update public.workspace_members set session_not_before = invitation.email_reverification_requested_at
  where workspace_id = workspace_id_value and user_id = p_user_id;
  return workspace_id_value;
end;
$$;

revoke all on function public.bootstrap_workspace_from_invitation(uuid, uuid, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.bootstrap_workspace_from_invitation(uuid, uuid, text, text, timestamptz)
to service_role;

drop trigger snapshot_question_version on public.questions;
create trigger snapshot_question_version
after insert or update of current_prompt, question_type, persona, stage, market, locale, rationale, state
on public.questions for each row execute procedure private.snapshot_question_version();

revoke update on public.questions from authenticated;
grant update (current_prompt, question_type, persona, stage, market, locale, rationale,
  state, disqualification_reason, active) on public.questions to authenticated;

create or replace function private.audit_material_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_row jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  workspace_value uuid;
  entity_value uuid;
  actor_value uuid;
  changed_fields jsonb;
  configured_actor text := nullif(current_setting('app.actor_user_id', true), '');
begin
  workspace_value := coalesce((after_row->>'workspace_id')::uuid, (before_row->>'workspace_id')::uuid);
  if workspace_value is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  entity_value := coalesce(nullif(after_row->>'id', '')::uuid, nullif(before_row->>'id', '')::uuid,
    nullif(after_row->>'user_id', '')::uuid, nullif(before_row->>'user_id', '')::uuid);
  actor_value := coalesce(configured_actor::uuid, auth.uid(), case when tg_op = 'INSERT' then coalesce(
    nullif(after_row->>'created_by', '')::uuid, nullif(after_row->>'requested_by', '')::uuid,
    nullif(after_row->>'reviewer_id', '')::uuid, nullif(after_row->>'invited_by', '')::uuid,
    nullif(after_row->>'updated_by', '')::uuid) end);
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into changed_fields
    from (select key from jsonb_object_keys(after_row) keys(key)
      where before_row->key is distinct from after_row->key
        and key not in ('credential_ciphertext', 'secret_ciphertext', 'token_hash')) changed;
  else
    changed_fields := '[]'::jsonb;
  end if;
  insert into public.audit_events (workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (workspace_value, actor_value, tg_table_name || '.' || lower(tg_op), tg_table_name,
    entity_value, jsonb_build_object('operation', lower(tg_op), 'changedFields', changed_fields));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.revoke_workspace_invitation(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_invitation_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_role public.workspace_role;
  invitation_role public.workspace_role;
  revoked_id uuid;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('admin') then
    raise exception using errcode = '42501', message = 'Actor cannot revoke invitations in this workspace.';
  end if;
  select wi.role into invitation_role from public.workspace_invitations wi
  where wi.id = p_invitation_id and wi.workspace_id = p_workspace_id
    and wi.accepted_at is null and wi.revoked_at is null and wi.expires_at > now() for update;
  if not found then raise exception using errcode = '23503', message = 'Open invitation was not found.'; end if;
  if invitation_role = 'owner' and actor_role <> 'owner' then
    raise exception using errcode = '42501', message = 'Only an owner can revoke an owner invitation.';
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  update public.workspace_invitations set revoked_at = now()
  where id = p_invitation_id and workspace_id = p_workspace_id returning id into revoked_id;
  return revoked_id;
end;
$$;

