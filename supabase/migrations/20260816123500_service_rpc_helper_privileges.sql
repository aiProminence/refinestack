-- Service-only RPCs validate the supplied mailbox actor with the same private
-- role-ranking helper used by RLS. Grant only that pure helper to service_role.

grant execute on function private.workspace_role_rank(public.workspace_role)
to service_role;
