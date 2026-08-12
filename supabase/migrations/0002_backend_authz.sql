-- 0002: Move authorization from RLS to the application backend.
--
-- The browser no longer queries PostgREST/Realtime directly. All data access
-- goes through the web app's API routes and the worker, both of which use the
-- service-role key and enforce ownership in application code. To keep the
-- anon/authenticated API keys from exposing data now that RLS is off, all
-- privileges on the public schema are revoked from those roles.

-- Drop every policy in the public schema.
do $$
declare pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
  loop
    execute format('drop policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- Disable RLS on all application tables.
alter table public.profiles        disable row level security;
alter table public.projects        disable row level security;
alter table public.workspaces      disable row level security;
alter table public.workspace_repos disable row level security;
alter table public.agents          disable row level security;
alter table public.tasks           disable row level security;
alter table public.task_runs       disable row level security;
alter table public.run_logs        disable row level security;
alter table public.messages        disable row level security;

-- Lock the data API: anon/authenticated keys can no longer touch public tables,
-- sequences, or functions (service_role retains full access).
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Future objects created by migrations get the same treatment.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
