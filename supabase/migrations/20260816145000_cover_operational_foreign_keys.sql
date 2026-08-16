-- Cover the schedule lineage foreign key introduced after the general
-- foreign-key indexing migration.
create index runs_schedule_project_workspace_idx
on public.runs(schedule_id, project_id, workspace_id);
