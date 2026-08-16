-- Run the durable capture worker from Supabase Cron so deployments do not
-- depend on Vercel's paid sub-daily cron tier. The endpoint and bearer secret
-- are provisioned separately in Supabase Vault and never enter migration SQL.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function private.dispatch_refinestack_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  worker_url text;
  worker_secret text;
begin
  select decrypted_secret
  into worker_url
  from vault.decrypted_secrets
  where name = 'refinestack_worker_url';

  select decrypted_secret
  into worker_secret
  from vault.decrypted_secrets
  where name = 'refinestack_worker_secret';

  -- An unconfigured scheduler is intentionally inert until both Vault values
  -- are provisioned after a deployment has been verified.
  if worker_url is null or worker_secret is null then
    return null;
  end if;

  if worker_url !~ '^https://([a-z0-9-]+\.)*refinestack\.com/api/internal/worker$'
     and worker_url !~ '^https://[a-z0-9-]+\.vercel\.app/api/internal/worker$' then
    raise exception using errcode = '22023', message = 'Invalid RefineStack worker URL';
  end if;

  if length(worker_secret) < 43 or worker_secret ~ '\s' then
    raise exception using errcode = '22023', message = 'Invalid RefineStack worker secret';
  end if;

  return net.http_post(
    url := worker_url,
    body := jsonb_build_object('limit', 2),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || worker_secret
    ),
    timeout_milliseconds := 300000
  );
end;
$$;

revoke all on function private.dispatch_refinestack_worker() from public, anon, authenticated, service_role;

select cron.schedule(
  'refinestack-worker-every-five-minutes',
  '*/5 * * * *',
  'select private.dispatch_refinestack_worker()'
);
