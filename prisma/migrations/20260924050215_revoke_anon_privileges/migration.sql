-- Revoke all privileges on public tables and sequences from the Supabase API
-- roles (anon, authenticated), including default privileges for objects that
-- "postgres" creates in the future.
--
-- Intent:
-- - Defense in depth on top of RLS: even if RLS were disabled on a table,
--   the API roles still could not read or write it.
-- - This app does not use supabase-js; all data access goes through Prisma
--   as "postgres", so this has no effect on the application.
-- - If a Supabase client is introduced later, explicit GRANTs and RLS
--   policies will be required for the tables it needs.
-- - Wrapped in a role-existence check so the migration also succeeds on
--   plain Postgres (local / shadow DB) where these roles do not exist.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
  END IF;
END
$$;
