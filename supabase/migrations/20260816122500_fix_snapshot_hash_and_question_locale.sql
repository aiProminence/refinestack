-- Supabase installs pgcrypto in the extensions schema. Keep trigger function
-- resolution explicit and separate question market from response locale.

alter function private.snapshot_project_version() set search_path = pg_catalog, extensions;
alter function private.snapshot_brand_version() set search_path = pg_catalog, extensions;
alter function private.snapshot_brand_from_alias() set search_path = pg_catalog, extensions;
alter function public.create_question_set(uuid, uuid, uuid, text, uuid[])
  set search_path = pg_catalog, extensions;

alter table public.questions add column locale text;
update public.questions q
set locale = p.default_locale
from public.projects p
where p.id = q.project_id and p.workspace_id = q.workspace_id;
alter table public.questions alter column locale set not null;
alter table public.questions add constraint questions_locale_not_blank
  check (char_length(trim(locale)) between 2 and 35);

create or replace function private.bump_question_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(old.current_prompt, old.question_type, old.persona, old.stage, old.market,
         old.locale, old.rationale, old.state)
     is distinct from
     row(new.current_prompt, new.question_type, new.persona, new.stage, new.market,
         new.locale, new.rationale, new.state) then
    new.current_version := old.current_version + 1;
  end if;
  return new;
end;
$$;
revoke all on function private.bump_question_version() from public, anon, authenticated;

create or replace function private.snapshot_question_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare snapshot_hash_value text;
begin
  snapshot_hash_value := encode(extensions.digest(concat_ws('|', new.current_prompt,
    new.question_type::text, new.persona, new.stage, new.market, new.locale,
    new.rationale, new.state::text), 'sha256'), 'hex');
  insert into public.question_versions (
    workspace_id, project_id, question_id, version, prompt, question_type,
    persona, stage, market, locale, rationale, qualification, snapshot_hash, created_by
  ) values (
    new.workspace_id, new.project_id, new.id, new.current_version, new.current_prompt,
    new.question_type, new.persona, new.stage, new.market, new.locale, new.rationale,
    jsonb_build_object('state', new.state, 'reason', new.disqualification_reason),
    snapshot_hash_value, coalesce((select auth.uid()), new.created_by)
  ) on conflict (question_id, snapshot_hash) do nothing;
  return new;
end;
$$;
revoke all on function private.snapshot_question_version() from public, anon, authenticated;
