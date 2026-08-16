-- Canonicalise the legacy run state vocabulary in its own transaction.
-- The following Release 1 migration can safely use these values after this
-- migration has committed.
alter type public.run_status rename value 'pending' to 'queued';
alter type public.run_status rename value 'completed' to 'succeeded';
alter type public.run_status add value if not exists 'cancelled';
