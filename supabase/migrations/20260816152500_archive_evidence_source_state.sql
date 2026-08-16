-- Evidence is retained rather than soft-deleted. Rename the legacy enum value
-- so historical rows keep their storage while the product exposes one clear
-- archive lifecycle.

alter type public.source_state rename value 'deleted' to 'archived';
