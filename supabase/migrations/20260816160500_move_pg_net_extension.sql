-- Supabase's security advisor requires relocatable extensions to be owned by
-- a non-public schema. Reinstall pg_net with extensions as its extension
-- namespace; pg_net continues to expose its supported API through net.*.

do $$
begin
  if exists (select 1 from net.http_request_queue) then
    raise exception using errcode = '55000', message = 'Cannot relocate pg_net while requests are pending';
  end if;
end;
$$;

drop function private.dispatch_refinestack_worker();
drop extension pg_net;
create extension pg_net with schema extensions;

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
