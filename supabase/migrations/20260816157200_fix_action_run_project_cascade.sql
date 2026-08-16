-- Project/workspace deletion can reach runs before actions. Preserve the
-- tenant-scoped follow-up relationship while allowing that parent cascade to
-- remove the child link regardless of referential-action ordering.

alter table public.action_run_links
  drop constraint action_run_links_run_id_project_id_workspace_id_fkey,
  add constraint action_run_links_run_id_project_id_workspace_id_fkey
    foreign key (run_id, project_id, workspace_id)
    references public.runs(id, project_id, workspace_id) on delete cascade;

