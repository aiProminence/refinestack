-- Resolve each pending classification once, with canonical before facts and a
-- validated after state written atomically by a service-only RPC.

create unique index classification_reviews_one_per_classification_idx
on public.classification_reviews(classification_id);

drop policy if exists classification_reviews_insert on public.classification_reviews;
revoke insert on public.classification_reviews from authenticated;

create or replace function public.submit_classification_review(
  p_workspace_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_classification_id uuid,
  p_decision public.review_status,
  p_reason text,
  p_after_value jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  classification public.brand_classifications%rowtype;
  actor_role public.workspace_role;
  before_value_value jsonb;
  after_value_value jsonb;
  review_id_value uuid;
  rank_value numeric;
begin
  select wm.role into actor_role from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_actor_id;
  if actor_role is null or private.workspace_role_rank(actor_role) < private.workspace_role_rank('analyst') then
    raise exception using errcode = '42501', message = 'Actor cannot review classifications in this workspace.';
  end if;
  if p_decision not in ('approved', 'overridden') or char_length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception using errcode = '22023', message = 'A valid review decision and reason are required.';
  end if;
  select * into classification from public.brand_classifications bc
  where bc.id = p_classification_id and bc.workspace_id = p_workspace_id
    and bc.project_id = p_project_id and bc.review_status = 'pending'
  for share;
  if not found then
    raise exception using errcode = '23503', message = 'Pending classification was not found.';
  end if;
  if exists (select 1 from public.classification_reviews cr where cr.classification_id = classification.id) then
    raise exception using errcode = '23505', message = 'Classification was already reviewed.';
  end if;

  before_value_value := jsonb_build_object(
    'mentioned', classification.mentioned, 'cited', classification.cited,
    'shortlisted', classification.shortlisted,
    'explicitlyRecommended', classification.explicitly_recommended,
    'firstChoice', classification.first_choice, 'rejected', classification.rejected,
    'rank', classification.rank
  );
  if p_decision = 'approved' then
    after_value_value := before_value_value;
  else
    if jsonb_typeof(p_after_value) <> 'object'
      or jsonb_typeof(p_after_value->'mentioned') <> 'boolean'
      or jsonb_typeof(p_after_value->'cited') <> 'boolean'
      or jsonb_typeof(p_after_value->'shortlisted') <> 'boolean'
      or jsonb_typeof(p_after_value->'explicitlyRecommended') <> 'boolean'
      or jsonb_typeof(p_after_value->'firstChoice') <> 'boolean'
      or jsonb_typeof(p_after_value->'rejected') <> 'boolean'
      or not (p_after_value ? 'rank') then
      raise exception using errcode = '22023', message = 'Override facts are incomplete.';
    end if;
    rank_value := case when p_after_value->'rank' = 'null'::jsonb then null else (p_after_value->>'rank')::numeric end;
    if rank_value is not null and (rank_value <= 0 or rank_value <> trunc(rank_value)) then
      raise exception using errcode = '22023', message = 'Override rank must be a positive whole number.';
    end if;
    after_value_value := jsonb_build_object(
      'mentioned', (p_after_value->>'mentioned')::boolean,
      'cited', (p_after_value->>'cited')::boolean,
      'shortlisted', (p_after_value->>'shortlisted')::boolean,
      'explicitlyRecommended', (p_after_value->>'explicitlyRecommended')::boolean,
      'firstChoice', (p_after_value->>'firstChoice')::boolean,
      'rejected', (p_after_value->>'rejected')::boolean,
      'rank', rank_value
    );
    if ((after_value_value->>'firstChoice')::boolean and not (after_value_value->>'explicitlyRecommended')::boolean)
      or ((after_value_value->>'explicitlyRecommended')::boolean and not (after_value_value->>'mentioned')::boolean)
      or ((after_value_value->>'shortlisted')::boolean and not (after_value_value->>'mentioned')::boolean) then
      raise exception using errcode = '23514', message = 'Override facts violate classification implications.';
    end if;
  end if;

  insert into public.classification_reviews (
    workspace_id, project_id, classification_id, reviewer_id, decision,
    reason, before_value, after_value
  ) values (
    p_workspace_id, p_project_id, classification.id, p_actor_id, p_decision,
    trim(p_reason), before_value_value, after_value_value
  ) returning id into review_id_value;
  return review_id_value;
end;
$$;

revoke all on function public.submit_classification_review(
  uuid, uuid, uuid, uuid, public.review_status, text, jsonb
) from public, anon, authenticated;
grant execute on function public.submit_classification_review(
  uuid, uuid, uuid, uuid, public.review_status, text, jsonb
) to service_role;
