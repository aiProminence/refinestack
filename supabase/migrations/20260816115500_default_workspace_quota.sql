-- Every workspace starts with an explicit hard cap. This makes run preflight
-- fail closed on a known quota instead of relying on an implicit application
-- default.

insert into public.workspace_quotas (workspace_id, monthly_call_limit, monthly_cost_limit_usd)
select w.id, 1000, 100
from public.workspaces w
on conflict (workspace_id) do nothing;

create or replace function private.initialize_workspace_quota()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.workspace_quotas (
    workspace_id, monthly_call_limit, monthly_cost_limit_usd, updated_by
  ) values (new.id, 1000, 100, new.created_by)
  on conflict (workspace_id) do nothing;
  return null;
end;
$$;

revoke all on function private.initialize_workspace_quota() from public, anon, authenticated;

create trigger initialize_workspace_quota
after insert on public.workspaces
for each row execute procedure private.initialize_workspace_quota();
