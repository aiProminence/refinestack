-- Add a deterministic covering index for every public foreign key whose
-- leading columns are not already covered. This keeps deletes, updates and
-- tenant-scoped joins predictable as workspaces grow.

do $migration$
declare
  foreign_key record;
  index_name text;
  column_list text;
begin
  for foreign_key in
    select constraint_row.oid,
           constraint_row.conrelid,
           constraint_row.conname,
           table_row.relname,
           constraint_row.conkey
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_row
      on table_row.oid = constraint_row.conrelid
    where constraint_row.contype = 'f'
      and constraint_row.connamespace = 'public'::regnamespace
      and not exists (
        select 1
        from pg_catalog.pg_index index_row
        where index_row.indrelid = constraint_row.conrelid
          and index_row.indisvalid
          and (index_row.indkey::smallint[])[0:cardinality(constraint_row.conkey) - 1]
            = constraint_row.conkey
      )
  loop
    select string_agg(quote_ident(attribute_row.attname), ', ' order by key_row.ordinality)
      into column_list
    from unnest(foreign_key.conkey) with ordinality key_row(attnum, ordinality)
    join pg_catalog.pg_attribute attribute_row
      on attribute_row.attrelid = foreign_key.conrelid
     and attribute_row.attnum = key_row.attnum;

    index_name := left(foreign_key.relname || '_' || foreign_key.conname, 42)
      || '_' || substr(md5(foreign_key.conname), 1, 12) || '_idx';

    execute format(
      'create index if not exists %I on %s (%s)',
      index_name,
      foreign_key.conrelid::regclass,
      column_list
    );
  end loop;
end;
$migration$;
