-- Cover the durable deletion-event lineage used for operational audits and
-- future retention checks without changing cleanup behavior.

create index workspace_storage_cleanup_jobs_deletion_event_idx
on private.workspace_storage_cleanup_jobs(deletion_event_id);
