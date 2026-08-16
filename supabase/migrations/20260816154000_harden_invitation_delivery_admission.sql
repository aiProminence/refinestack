-- Make invitation delivery and mailbox-verification admission explicit,
-- replay-safe, rate-limited, and auditable. All mutation entry points are
-- service-only; browser roles retain read-only invitation access.

alter table public.workspace_invitations
  add column notification_delivery_status text not null default 'pending',
  add column notification_delivery_attempts integer not null default 0,
  add column notification_delivery_last_attempted_at timestamptz,
  add column notification_delivery_sent_at timestamptz,
  add column notification_delivery_failure_code text,
  add column otp_admission_id uuid,
  add column otp_admission_status text,
  add column otp_admitted_at timestamptz,
  add column otp_last_attempted_at timestamptz,
  add column signup_proof_consumed_at timestamptz,
  add constraint invitation_notification_delivery_status_check
    check (notification_delivery_status in ('pending', 'sent', 'failed')),
  add constraint invitation_notification_delivery_attempts_check
    check (notification_delivery_attempts >= 0),
  add constraint invitation_notification_failure_code_check
    check (
      notification_delivery_failure_code is null
      or (
        length(notification_delivery_failure_code) between 1 and 80
        and notification_delivery_failure_code ~ '^[a-z0-9_:-]+$'
      )
    ),
  add constraint invitation_otp_admission_status_check
    check (otp_admission_status is null or otp_admission_status in ('admitted', 'sent', 'failed')),
  add constraint invitation_otp_admission_shape_check
    check (
      (otp_admission_id is null and otp_admission_status is null and otp_admitted_at is null)
      or (otp_admission_id is not null and otp_admission_status is not null and otp_admitted_at is not null)
    );

-- Invitations created before this migration already traversed the legacy
-- delivery path. Preserve their usability while making all new rows pending
-- until the delivery recorder finalizes them.
update public.workspace_invitations
set notification_delivery_status = case when revoked_at is null then 'sent' else 'failed' end,
    notification_delivery_attempts = 1,
    notification_delivery_last_attempted_at = created_at,
    notification_delivery_sent_at = case when revoked_at is null then created_at else null end,
    notification_delivery_failure_code = case when revoked_at is null then null else 'legacy_revoked' end;

create index workspace_invitations_otp_active_idx
on public.workspace_invitations (otp_admitted_at)
where otp_admission_status in ('admitted', 'sent') and accepted_at is null and revoked_at is null;

create table private.invitation_delivery_events (
  id bigint generated always as identity primary key,
  invitation_id uuid not null,
  workspace_id uuid,
  actor_user_id uuid,
  event_type text not null check (event_type in (
    'notification_sent', 'notification_failed', 'otp_admitted', 'otp_sent', 'otp_failed'
  )),
  attempt_id uuid,
  failure_code text check (
    failure_code is null or (
      length(failure_code) between 1 and 80 and failure_code ~ '^[a-z0-9_:-]+$'
    )
  ),
  created_at timestamptz not null default now()
);

create index invitation_delivery_events_invitation_idx
on private.invitation_delivery_events (invitation_id, created_at desc);

revoke all on table private.invitation_delivery_events from public, anon, authenticated;
grant insert, select on table private.invitation_delivery_events to service_role;
revoke all on sequence private.invitation_delivery_events_id_seq from public, anon, authenticated;
grant usage, select on sequence private.invitation_delivery_events_id_seq to service_role;

create trigger immutable_invitation_delivery_events
before update or delete on private.invitation_delivery_events
for each row execute procedure private.prevent_immutable_mutation();

create or replace function public.record_invitation_notification_delivery(
  p_invitation_id uuid,
  p_succeeded boolean,
  p_failure_code text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
  actor_role public.workspace_role;
  normalized_failure_code text := nullif(lower(trim(p_failure_code)), '');
begin
  if normalized_failure_code is not null and (
    length(normalized_failure_code) > 80
    or normalized_failure_code !~ '^[a-z0-9_:-]+$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid invitation delivery failure code.';
  end if;
  if not p_succeeded and normalized_failure_code is null then
    raise exception using errcode = '22023', message = 'A delivery failure code is required.';
  end if;

  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'Invitation was not found.';
  end if;
  if invitation.invitation_kind = 'workspace' then
    if p_actor_id is null or p_actor_id <> invitation.invited_by then
      raise exception using errcode = '42501', message = 'Invitation delivery actor is invalid.';
    end if;
    select wm.role into actor_role from public.workspace_members wm
    where wm.workspace_id = invitation.workspace_id and wm.user_id = p_actor_id;
    if actor_role is null
      or private.workspace_role_rank(actor_role) < private.workspace_role_rank('admin')
      or (invitation.role = 'owner' and actor_role <> 'owner') then
      raise exception using errcode = '42501', message = 'Invitation delivery actor is not authorized.';
    end if;
  elsif p_actor_id is not null then
    raise exception using errcode = '42501', message = 'Bootstrap delivery cannot specify an actor.';
  end if;

  if invitation.notification_delivery_status <> 'pending' then
    if (p_succeeded and invitation.notification_delivery_status = 'sent')
      or (not p_succeeded and invitation.notification_delivery_status = 'failed') then
      return jsonb_build_object(
        'id', invitation.id,
        'status', invitation.notification_delivery_status,
        'replayed', true
      );
    end if;
    raise exception using errcode = '23514', message = 'Invitation delivery already reached a terminal state.';
  end if;

  if p_actor_id is not null then
    perform set_config('app.actor_user_id', p_actor_id::text, true);
  end if;
  update public.workspace_invitations
  set notification_delivery_status = case when p_succeeded then 'sent' else 'failed' end,
      notification_delivery_attempts = notification_delivery_attempts + 1,
      notification_delivery_last_attempted_at = now(),
      notification_delivery_sent_at = case when p_succeeded then now() else null end,
      notification_delivery_failure_code = case when p_succeeded then null else normalized_failure_code end,
      revoked_at = case when p_succeeded then revoked_at else coalesce(revoked_at, now()) end
  where id = invitation.id;

  insert into private.invitation_delivery_events (
    invitation_id, workspace_id, actor_user_id, event_type, failure_code
  ) values (
    invitation.id, invitation.workspace_id, p_actor_id,
    case when p_succeeded then 'notification_sent' else 'notification_failed' end,
    case when p_succeeded then null else normalized_failure_code end
  );
  return jsonb_build_object(
    'id', invitation.id,
    'status', case when p_succeeded then 'sent' else 'failed' end,
    'replayed', false
  );
end;
$$;

revoke all on function public.record_invitation_notification_delivery(uuid, boolean, text, uuid)
from public, anon, authenticated;
grant execute on function public.record_invitation_notification_delivery(uuid, boolean, text, uuid)
to service_role;

create or replace function public.admit_invitation_mailbox_otp(
  p_invitation_id uuid,
  p_signup_proof_hash text default null,
  p_authenticated_user_id uuid default null,
  p_existing_user_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
  admission_id uuid := extensions.gen_random_uuid();
  admitted_at timestamptz := clock_timestamp();
  effective_user_id uuid;
begin
  if (p_signup_proof_hash is null) = (p_authenticated_user_id is null) then
    raise exception using errcode = '22023', message = 'Exactly one invitation admission credential is required.';
  end if;
  if p_signup_proof_hash is not null and p_signup_proof_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invitation proof hash is invalid.';
  end if;
  if p_authenticated_user_id is not null and p_existing_user_id is not null then
    raise exception using errcode = '22023', message = 'Authenticated admission cannot rebind an invitation.';
  end if;

  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found or invitation.accepted_at is not null or invitation.revoked_at is not null
    or invitation.expires_at <= now()
    or invitation.notification_delivery_status not in ('pending', 'sent') then
    raise exception using errcode = '42501', message = 'Invitation is invalid or expired.';
  end if;

  if p_signup_proof_hash is not null then
    if invitation.signup_proof_hash <> p_signup_proof_hash
      or invitation.signup_proof_consumed_at is not null then
      raise exception using errcode = '42501', message = 'Invitation claim has already been used or is invalid.';
    end if;
    if p_existing_user_id is not null then
      if invitation.invited_user_id is not null and invitation.invited_user_id <> p_existing_user_id then
        raise exception using errcode = '42501', message = 'Invitation is bound to a different account.';
      end if;
      update public.workspace_invitations set invited_user_id = p_existing_user_id
      where id = invitation.id and invited_user_id is null;
      effective_user_id := p_existing_user_id;
    else
      effective_user_id := invitation.invited_user_id;
    end if;
  else
    if invitation.invited_user_id is null or invitation.invited_user_id <> p_authenticated_user_id then
      raise exception using errcode = '42501', message = 'Invitation is not bound to this account.';
    end if;
    effective_user_id := p_authenticated_user_id;
  end if;

  if invitation.otp_admission_status in ('admitted', 'sent')
    and invitation.otp_admitted_at > now() - interval '15 minutes' then
    raise exception using errcode = '55P03', message = 'Invitation mailbox verification is already active.';
  end if;
  if invitation.otp_last_attempted_at is not null
    and invitation.otp_last_attempted_at > now() - interval '60 seconds' then
    raise exception using errcode = '55P03', message = 'Invitation mailbox verification is cooling down.';
  end if;

  if p_authenticated_user_id is not null then
    perform set_config('app.actor_user_id', p_authenticated_user_id::text, true);
  end if;
  update public.workspace_invitations
  set otp_admission_id = admission_id,
      otp_admission_status = 'admitted',
      otp_admitted_at = admitted_at,
      otp_last_attempted_at = admitted_at,
      email_reverification_requested_at = admitted_at
  where id = invitation.id;

  insert into private.invitation_delivery_events (
    invitation_id, workspace_id, actor_user_id, event_type, attempt_id
  ) values (
    invitation.id, invitation.workspace_id, p_authenticated_user_id, 'otp_admitted', admission_id
  );
  return jsonb_build_object(
    'id', invitation.id,
    'email', invitation.email,
    'attempt_id', admission_id,
    'requested_at', admitted_at,
    'should_create_user', effective_user_id is null
  );
end;
$$;

revoke all on function public.admit_invitation_mailbox_otp(uuid, text, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admit_invitation_mailbox_otp(uuid, text, uuid, uuid)
to service_role;

create or replace function public.finalize_invitation_mailbox_otp(
  p_invitation_id uuid,
  p_attempt_id uuid,
  p_succeeded boolean,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
  normalized_failure_code text := nullif(lower(trim(p_failure_code)), '');
begin
  if normalized_failure_code is not null and (
    length(normalized_failure_code) > 80
    or normalized_failure_code !~ '^[a-z0-9_:-]+$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid OTP delivery failure code.';
  end if;
  if not p_succeeded and normalized_failure_code is null then
    raise exception using errcode = '22023', message = 'An OTP delivery failure code is required.';
  end if;

  select * into invitation from public.workspace_invitations
  where id = p_invitation_id for update;
  if not found or invitation.otp_admission_id <> p_attempt_id then
    raise exception using errcode = '42501', message = 'Mailbox verification admission is invalid.';
  end if;
  if invitation.otp_admission_status <> 'admitted' then
    if (p_succeeded and invitation.otp_admission_status = 'sent')
      or (not p_succeeded and invitation.otp_admission_status = 'failed') then
      return jsonb_build_object(
        'id', invitation.id,
        'status', invitation.otp_admission_status,
        'replayed', true
      );
    end if;
    raise exception using errcode = '23514', message = 'Mailbox verification admission already reached a terminal state.';
  end if;

  update public.workspace_invitations
  set otp_admission_status = case when p_succeeded then 'sent' else 'failed' end,
      signup_proof_consumed_at = case
        when p_succeeded then coalesce(signup_proof_consumed_at, now())
        else signup_proof_consumed_at
      end,
      email_reverification_requested_at = case
        when p_succeeded then email_reverification_requested_at
        else null
      end
  where id = invitation.id;

  insert into private.invitation_delivery_events (
    invitation_id, workspace_id, actor_user_id, event_type, attempt_id, failure_code
  ) values (
    invitation.id, invitation.workspace_id, null,
    case when p_succeeded then 'otp_sent' else 'otp_failed' end,
    p_attempt_id, case when p_succeeded then null else normalized_failure_code end
  );
  return jsonb_build_object(
    'id', invitation.id,
    'status', case when p_succeeded then 'sent' else 'failed' end,
    'replayed', false
  );
end;
$$;

revoke all on function public.finalize_invitation_mailbox_otp(uuid, uuid, boolean, text)
from public, anon, authenticated;
grant execute on function public.finalize_invitation_mailbox_otp(uuid, uuid, boolean, text)
to service_role;

-- A raw claim is not an Auth signup credential by itself. It is accepted only
-- during the short, atomic admission window opened by the application.
create or replace function private.hook_require_beta_invite(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  signup_email text := lower(trim(event->'user'->>'email'));
  signup_proof text := event->'user'->'user_metadata'->>'invitation_proof';
  proof_hash text;
begin
  if nullif(signup_proof, '') is not null then
    proof_hash := encode(extensions.digest(signup_proof, 'sha256'), 'hex');
  end if;
  if signup_email is null or proof_hash is null or not exists (
    select 1 from public.workspace_invitations wi
    where wi.email = signup_email and wi.signup_proof_hash = proof_hash
      and wi.signup_proof_consumed_at is null
      and wi.notification_delivery_status in ('pending', 'sent')
      and wi.otp_admission_status = 'admitted'
      and wi.otp_admitted_at > now() - interval '5 minutes'
      and wi.accepted_at is null and wi.revoked_at is null
      and wi.expires_at > now() and wi.invited_user_id is null
  ) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This private beta is invitation-only.'
    ));
  end if;
  return '{}'::jsonb;
end;
$$;

create or replace function private.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  signup_proof text := new.raw_user_meta_data->>'invitation_proof';
  proof_hash text;
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;
  if nullif(signup_proof, '') is not null then
    proof_hash := encode(extensions.digest(signup_proof, 'sha256'), 'hex');
    update public.workspace_invitations wi set invited_user_id = new.id
    where wi.email = lower(trim(new.email)) and wi.signup_proof_hash = proof_hash
      and wi.signup_proof_consumed_at is null
      and wi.notification_delivery_status in ('pending', 'sent')
      and wi.otp_admission_status = 'admitted'
      and wi.otp_admitted_at > now() - interval '5 minutes'
      and wi.invited_user_id is null and wi.accepted_at is null
      and wi.revoked_at is null and wi.expires_at > now();
  end if;
  return new;
end;
$$;
