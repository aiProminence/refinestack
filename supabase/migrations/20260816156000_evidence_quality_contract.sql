-- Immutable evidence quality configuration, deterministic prompt-injection
-- flags, and service-only structured claims for conflict intelligence.

update public.sources
set authority_weight = coalesce(authority_weight, 0.5000),
    freshness_days = coalesce(freshness_days, 90)
where authority_weight is null or freshness_days is null;

alter table public.sources
  alter column authority_weight set default 0.5000,
  alter column authority_weight set not null,
  alter column freshness_days set default 90,
  alter column freshness_days set not null;

alter table public.source_versions
  add column authority_weight_snapshot numeric(5,4),
  add column freshness_days_snapshot integer,
  add column prompt_injection_flags text[] not null default '{}'::text[];

update public.source_versions sv
set authority_weight_snapshot = s.authority_weight,
    freshness_days_snapshot = s.freshness_days
from public.sources s
where s.id = sv.source_id;

alter table public.source_versions
  alter column authority_weight_snapshot set not null,
  alter column freshness_days_snapshot set not null,
  add constraint source_versions_authority_weight_snapshot_check
    check (authority_weight_snapshot between 0 and 1),
  add constraint source_versions_freshness_days_snapshot_check
    check (freshness_days_snapshot > 0);

alter table public.source_claims
  add column authority_weight_snapshot numeric(5,4),
  add column freshness_days_snapshot integer,
  add column prompt_injection_flags text[] not null default '{}'::text[],
  add column created_by uuid references auth.users(id) on delete set null;

update public.source_claims sc
set authority_weight_snapshot = sv.authority_weight_snapshot,
    freshness_days_snapshot = sv.freshness_days_snapshot,
    prompt_injection_flags = sv.prompt_injection_flags
from public.source_versions sv
where sv.id = sc.source_version_id;

alter table public.source_claims
  alter column authority_weight_snapshot set not null,
  alter column freshness_days_snapshot set not null,
  add constraint source_claims_authority_weight_snapshot_check
    check (authority_weight_snapshot between 0 and 1),
  add constraint source_claims_freshness_days_snapshot_check
    check (freshness_days_snapshot > 0);

create index source_versions_current_content_hash_idx
on public.source_versions(project_id, content_hash, source_id)
where valid_until is null;

create index sources_active_canonical_url_idx
on public.sources(project_id, canonical_url, id)
where state = 'active' and canonical_url is not null;

create index source_claims_conflict_group_idx
on public.source_claims(project_id, conflict_group, source_version_id)
where conflict_group is not null;

create or replace function private.detect_evidence_prompt_injection(p_content text)
returns text[]
language sql
immutable
strict
set search_path = ''
as $$
  select array_remove(array[
    case when p_content ~* 'ignore[[:space:]]+(all|any|the|previous|prior|above|system|developer)[^.!?]{0,80}instruction' then 'instruction_override' end,
    case when p_content ~* '(system|developer|assistant)[[:space:]_-]*(prompt|message|instruction)' then 'role_impersonation' end,
    case when p_content ~* '(call|invoke|use|run|execute)[[:space:]]+(a[[:space:]]+|the[[:space:]]+)?(tool|function|command|shell|api)' then 'tool_invocation' end,
    case when p_content ~* '(reveal|print|show|return|exfiltrate|leak)[^.!?]{0,80}(secret|password|api[[:space:]_-]*key|token|credential|environment)' then 'secret_exfiltration' end,
    case when p_content ~* '(<[[:space:]]*(system|developer|assistant|tool)|\[(system|developer|assistant|tool)\])' then 'role_markup' end
  ], null);
$$;
revoke all on function private.detect_evidence_prompt_injection(text)
from public, anon, authenticated;

create or replace function private.default_source_version_quality()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.authority_weight_snapshot is null or new.freshness_days_snapshot is null then
    select coalesce(new.authority_weight_snapshot, s.authority_weight),
      coalesce(new.freshness_days_snapshot, s.freshness_days)
    into new.authority_weight_snapshot, new.freshness_days_snapshot
    from public.sources s
    where s.id = new.source_id and s.workspace_id = new.workspace_id
      and s.project_id = new.project_id;
  end if;
  if new.content_text is not null then
    new.prompt_injection_flags := private.detect_evidence_prompt_injection(new.content_text);
  end if;
  return new;
end;
$$;
revoke all on function private.default_source_version_quality()
from public, anon, authenticated;
create trigger default_source_version_quality before insert on public.source_versions
for each row execute procedure private.default_source_version_quality();

drop trigger immutable_source_versions on public.source_versions;
create or replace function private.protect_source_version_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.workspace_id, new.project_id, new.source_id, new.version, new.content_text,
      new.storage_path, new.content_hash, new.mime_type, new.retrieved_at,
      new.valid_from, new.retrieval_metadata, new.retrieval_allowed,
      new.quoting_allowed, new.export_allowed, new.authority_weight_snapshot,
      new.freshness_days_snapshot, new.prompt_injection_flags,
      new.created_by, new.created_at)
    is distinct from
    row(old.workspace_id, old.project_id, old.source_id, old.version, old.content_text,
      old.storage_path, old.content_hash, old.mime_type, old.retrieved_at,
      old.valid_from, old.retrieval_metadata, old.retrieval_allowed,
      old.quoting_allowed, old.export_allowed, old.authority_weight_snapshot,
      old.freshness_days_snapshot, old.prompt_injection_flags,
      old.created_by, old.created_at)
    or old.valid_until is not null or new.valid_until is null then
    raise exception using errcode = '55000', message = 'Source version content, policy, and quality configuration are immutable.';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_source_version_immutability()
from public, anon, authenticated;
create trigger immutable_source_versions before update on public.source_versions
for each row execute procedure private.protect_source_version_immutability();

create or replace function private.prevent_source_claim_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'Evidence claims are immutable.';
end;
$$;
revoke all on function private.prevent_source_claim_mutation()
from public, anon, authenticated;
create trigger immutable_source_claims before update on public.source_claims
for each row execute procedure private.prevent_source_claim_mutation();

create or replace function public.create_quality_evidence_source(
  p_workspace_id uuid, p_project_id uuid, p_actor_id uuid, p_kind public.source_kind,
  p_name text, p_original_url text, p_canonical_url text, p_content_text text,
  p_storage_path text, p_content_hash text, p_mime_type text, p_retrieved_at timestamptz,
  p_retrieval_metadata jsonb, p_retrieval_allowed boolean, p_quoting_allowed boolean,
  p_export_allowed boolean, p_authority_weight numeric, p_freshness_days integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare source_id_value uuid; actor_role public.workspace_role;
  injection_flags text[] := '{}'::text[];
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot create evidence in this workspace.';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.workspace_id = p_workspace_id) then
    raise exception using errcode = '23503', message = 'Project is outside the actor workspace.';
  end if;
  if nullif(trim(p_name), '') is null or (p_content_text is null and p_storage_path is null)
    or p_authority_weight is null or p_authority_weight < 0 or p_authority_weight > 1
    or p_freshness_days is null or p_freshness_days <= 0 then
    raise exception using errcode = '22023', message = 'Evidence content and valid quality configuration are required.';
  end if;
  if p_content_text is not null then
    injection_flags := private.detect_evidence_prompt_injection(p_content_text);
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  insert into public.sources (workspace_id, project_id, kind, name, original_url, canonical_url,
    retrieval_allowed, quoting_allowed, export_allowed, authority_weight, freshness_days, created_by)
  values (p_workspace_id, p_project_id, p_kind, trim(p_name), p_original_url, p_canonical_url,
    p_retrieval_allowed, p_quoting_allowed, p_export_allowed, p_authority_weight,
    p_freshness_days, p_actor_id) returning id into source_id_value;
  insert into public.source_versions (workspace_id, project_id, source_id, version, content_text,
    storage_path, content_hash, mime_type, retrieved_at, retrieval_metadata,
    retrieval_allowed, quoting_allowed, export_allowed, authority_weight_snapshot,
    freshness_days_snapshot, prompt_injection_flags, created_by)
  values (p_workspace_id, p_project_id, source_id_value, 1, p_content_text, p_storage_path,
    p_content_hash, p_mime_type, p_retrieved_at, coalesce(p_retrieval_metadata, '{}'::jsonb),
    p_retrieval_allowed, p_quoting_allowed, p_export_allowed, p_authority_weight,
    p_freshness_days, injection_flags, p_actor_id);
  return source_id_value;
end;
$$;

create or replace function public.append_quality_evidence_source_version(
  p_workspace_id uuid, p_project_id uuid, p_source_id uuid, p_actor_id uuid,
  p_content_text text, p_storage_path text, p_content_hash text, p_mime_type text,
  p_retrieved_at timestamptz, p_retrieval_metadata jsonb,
  p_authority_weight numeric, p_freshness_days integer
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare source_row public.sources%rowtype; actor_role public.workspace_role;
  next_version integer; version_id uuid; injection_flags text[] := '{}'::text[];
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot version evidence in this workspace.';
  end if;
  select * into source_row from public.sources s where s.id = p_source_id
    and s.workspace_id = p_workspace_id and s.project_id = p_project_id for update;
  if not found then raise exception using errcode = '23503', message = 'Evidence source was not found.'; end if;
  if source_row.state <> 'active' then raise exception using errcode = '55000', message = 'Archived evidence cannot receive a new version.'; end if;
  if (p_content_text is null and p_storage_path is null)
    or p_authority_weight is null or p_authority_weight < 0 or p_authority_weight > 1
    or p_freshness_days is null or p_freshness_days <= 0 then
    raise exception using errcode = '22023', message = 'Evidence content and valid quality configuration are required.';
  end if;
  if p_content_text is not null then
    injection_flags := private.detect_evidence_prompt_injection(p_content_text);
  end if;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  select coalesce(max(version), 0) + 1 into next_version from public.source_versions
  where source_id = p_source_id;
  update public.source_versions set valid_until = now()
  where source_id = p_source_id and valid_until is null;
  update public.sources set authority_weight = p_authority_weight,
    freshness_days = p_freshness_days, updated_at = now()
  where id = p_source_id;
  insert into public.source_versions (workspace_id, project_id, source_id, version, content_text,
    storage_path, content_hash, mime_type, retrieved_at, retrieval_metadata,
    retrieval_allowed, quoting_allowed, export_allowed, authority_weight_snapshot,
    freshness_days_snapshot, prompt_injection_flags, created_by)
  values (p_workspace_id, p_project_id, p_source_id, next_version, p_content_text, p_storage_path,
    p_content_hash, p_mime_type, p_retrieved_at, coalesce(p_retrieval_metadata, '{}'::jsonb),
    source_row.retrieval_allowed, source_row.quoting_allowed, source_row.export_allowed,
    p_authority_weight, p_freshness_days, injection_flags, p_actor_id)
  returning id into version_id;
  return version_id;
end;
$$;

create or replace function public.record_evidence_claim(
  p_workspace_id uuid, p_project_id uuid, p_source_version_id uuid, p_actor_id uuid,
  p_claim_text text, p_evidence_excerpt text, p_conflict_group text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare actor_role public.workspace_role; version_row public.source_versions%rowtype;
  claim_id uuid; freshness_value text; normalized_group text;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot record evidence claims in this workspace.';
  end if;
  select * into version_row from public.source_versions sv
  where sv.id = p_source_version_id and sv.workspace_id = p_workspace_id
    and sv.project_id = p_project_id for share;
  if not found then raise exception using errcode = '23503', message = 'Evidence version was not found.'; end if;
  if nullif(trim(p_claim_text), '') is null or char_length(trim(p_claim_text)) > 2000
    or (p_evidence_excerpt is not null and char_length(trim(p_evidence_excerpt)) > 4000)
    or (p_conflict_group is not null and char_length(trim(p_conflict_group)) > 160) then
    raise exception using errcode = '22023', message = 'Claim text or conflict topic is invalid.';
  end if;
  normalized_group := nullif(lower(regexp_replace(trim(p_conflict_group), '[[:space:]]+', ' ', 'g')), '');
  freshness_value := case
    when version_row.retrieved_at is null or version_row.retrieved_at > now() then 'unknown'
    when version_row.retrieved_at + make_interval(days => version_row.freshness_days_snapshot) < now() then 'stale'
    else 'current'
  end;
  perform set_config('app.actor_user_id', p_actor_id::text, true);
  insert into public.source_claims (workspace_id, project_id, source_version_id,
    claim_text, evidence_excerpt, freshness_state, conflict_group,
    authority_weight_snapshot, freshness_days_snapshot, prompt_injection_flags, created_by)
  values (p_workspace_id, p_project_id, p_source_version_id, trim(p_claim_text),
    nullif(trim(p_evidence_excerpt), ''), freshness_value, normalized_group,
    version_row.authority_weight_snapshot, version_row.freshness_days_snapshot,
    version_row.prompt_injection_flags, p_actor_id)
  returning id into claim_id;
  return claim_id;
end;
$$;

revoke all on function public.create_quality_evidence_source(
  uuid,uuid,uuid,public.source_kind,text,text,text,text,text,text,text,timestamptz,
  jsonb,boolean,boolean,boolean,numeric,integer
) from public, anon, authenticated;
grant execute on function public.create_quality_evidence_source(
  uuid,uuid,uuid,public.source_kind,text,text,text,text,text,text,text,timestamptz,
  jsonb,boolean,boolean,boolean,numeric,integer
) to service_role;
revoke all on function public.append_quality_evidence_source_version(
  uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb,numeric,integer
) from public, anon, authenticated;
grant execute on function public.append_quality_evidence_source_version(
  uuid,uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb,numeric,integer
) to service_role;
revoke all on function public.record_evidence_claim(uuid,uuid,uuid,uuid,text,text,text)
from public, anon, authenticated;
grant execute on function public.record_evidence_claim(uuid,uuid,uuid,uuid,text,text,text)
to service_role;

revoke insert, update, delete on public.source_claims from authenticated;
