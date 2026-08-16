-- Evidence claims are immutable during ordinary operation, including for the
-- service role. Permit deletion only inside the audited, owner-authorized
-- workspace deletion transaction so a workspace can still be fully erased.

create or replace function private.prevent_source_claim_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and nullif(current_setting('app.workspace_deletion_id', true), '') = old.workspace_id::text then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'Evidence claims are immutable.';
end;
$$;
revoke all on function private.prevent_source_claim_mutation()
from public, anon, authenticated;

drop trigger immutable_source_claims on public.source_claims;
create trigger immutable_source_claims before update or delete on public.source_claims
for each row execute procedure private.prevent_source_claim_mutation();
