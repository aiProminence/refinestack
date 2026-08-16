-- Bind Auth user creation to an unguessable server-generated invitation proof
-- and persist the time at which a second mailbox verification was requested.

alter table public.workspace_invitations
  add column signup_proof_hash text not null
    check (signup_proof_hash ~ '^[a-f0-9]{64}$'),
  add column email_reverification_requested_at timestamptz;

create or replace function private.protect_invitation_security_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.signup_proof_hash is distinct from old.signup_proof_hash then
    raise exception using errcode = '23514', message = 'Invitation signup proof is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_invitation_security_fields() from public, anon, authenticated;

create trigger protect_invitation_security_fields
before update of signup_proof_hash on public.workspace_invitations
for each row execute procedure private.protect_invitation_security_fields();

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
      and wi.invited_user_id is null and wi.accepted_at is null
      and wi.revoked_at is null and wi.expires_at > now();
  end if;
  return new;
end;
$$;

