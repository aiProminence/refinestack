-- The rate-limit RPC is SECURITY INVOKER, so service_role needs explicit
-- privileges on the table introduced after the Release 1 blanket grants.
grant select, insert, update, delete on public.api_rate_limit_windows to service_role;
