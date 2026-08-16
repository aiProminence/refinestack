-- The first normalized-prompt index preserved leading/trailing whitespace.
-- Recreate it with a final trim so direct inserts cannot evade exact-duplicate
-- protection by padding the prompt.

drop index public.questions_active_normalized_prompt_unique;
create unique index questions_active_normalized_prompt_unique
on public.questions (
  project_id,
  lower(trim(regexp_replace(normalize(current_prompt, NFKC), '\s+', ' ', 'g')))
)
where state = 'active';
