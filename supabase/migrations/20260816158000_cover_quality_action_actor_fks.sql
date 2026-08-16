-- Cover newly introduced auth-user attribution foreign keys so account
-- deletion and workspace cleanup do not require full child-table scans.

create index source_claims_created_by_fk_idx
  on public.source_claims(created_by)
  where created_by is not null;

create index action_run_links_linked_by_fk_idx
  on public.action_run_links(linked_by)
  where linked_by is not null;
