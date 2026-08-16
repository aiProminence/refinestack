-- Keep the execution boundary aligned with the deterministic question editor.
-- Client-side or direct Data API writes cannot place incomplete active
-- questions into provider fan-out.

alter table public.questions
  add constraint questions_active_metadata_complete check (
    state <> 'active'
    or (
      char_length(trim(current_prompt)) between 18 and 500
      and persona is not null and char_length(trim(persona)) >= 2
      and stage is not null and char_length(trim(stage)) >= 2
      and rationale is not null and char_length(trim(rationale)) >= 12
      and array_length(regexp_split_to_array(trim(rationale), '\s+'), 1) >= 3
      and lower(trim(persona)) !~ '^(n/?a|none|unknown|tbd|test|general|other|-+)$'
      and lower(trim(stage)) !~ '^(n/?a|none|unknown|tbd|test|general|other|-+)$'
      and current_prompt !~* '\m(obviously|clearly|isn''t it true|wouldn''t you agree)\M'
    )
  ) not valid;
alter table public.questions validate constraint questions_active_metadata_complete;

create unique index questions_active_normalized_prompt_unique
on public.questions (
  project_id,
  lower(regexp_replace(normalize(current_prompt, NFKC), '\s+', ' ', 'g'))
)
where state = 'active';

create or replace function private.validate_run_item_question_quality()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare question_version public.question_versions%rowtype;
begin
  select * into question_version
  from public.question_versions qv
  where qv.id = new.question_version_id
    and qv.project_id = new.project_id
    and qv.workspace_id = new.workspace_id;
  if not found then
    raise exception using errcode = '23503', message = 'Run question version was not found.';
  end if;
  if coalesce(question_version.qualification->>'state', '') <> 'active'
    or char_length(trim(question_version.prompt)) not between 18 and 500
    or question_version.persona is null or char_length(trim(question_version.persona)) < 2
    or question_version.stage is null or char_length(trim(question_version.stage)) < 2
    or question_version.rationale is null or char_length(trim(question_version.rationale)) < 12
    or array_length(regexp_split_to_array(trim(question_version.rationale), '\s+'), 1) < 3
    or lower(trim(question_version.persona)) ~ '^(n/?a|none|unknown|tbd|test|general|other|-+)$'
    or lower(trim(question_version.stage)) ~ '^(n/?a|none|unknown|tbd|test|general|other|-+)$'
    or question_version.prompt ~* '\m(obviously|clearly|isn''t it true|wouldn''t you agree)\M' then
    raise exception using errcode = '23514', message = 'Run question does not satisfy the active question quality contract.';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_run_item_question_quality() from public, anon, authenticated;

create trigger validate_run_item_question_quality
before insert on public.run_items
for each row execute procedure private.validate_run_item_question_quality();
