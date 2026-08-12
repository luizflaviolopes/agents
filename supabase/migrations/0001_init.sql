-- Agent Fleet — initial schema
-- All ids: uuid primary key default gen_random_uuid()
-- All timestamps: timestamptz

-- ===========================================================================
-- Tables
-- ===========================================================================

-- profiles ------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  telegram_chat_id text unique,
  telegram_link_code text unique,
  created_at timestamptz default now()
);

-- Auto-insert a profile row when an auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- projects ------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz default now()
);

-- workspaces ----------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  -- Slugified folder name on the worker's disk under WORKSPACES_ROOT.
  path text not null,
  created_at timestamptz default now(),
  unique (project_id, name)
);

-- workspace_repos -------------------------------------------------------------
create table public.workspace_repos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  repo_url text not null,
  branch text not null,
  folder_name text not null,
  clone_status text not null default 'pending'
    check (clone_status in ('pending', 'cloning', 'ready', 'error')),
  error text,
  created_at timestamptz default now(),
  unique (workspace_id, folder_name)
);

-- agents ----------------------------------------------------------------------
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete set null,
  name text not null,
  role text not null default 'specialist'
    check (role in ('manager', 'specialist')),
  instructions text not null default '',
  model text not null default 'claude-sonnet-5',
  plugins jsonb not null default '[]',
  mcp_servers jsonb not null default '[]',
  is_active boolean not null default true,
  created_at timestamptz default now()
);

-- Only one manager agent per project.
create unique index one_manager_per_project
  on public.agents (project_id)
  where role = 'manager';

-- tasks -----------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  source text not null default 'web'
    check (source in ('web', 'telegram', 'manager', 'system')),
  title text not null,
  description text not null default '',
  status text not null default 'queued'
    check (status in ('queued', 'in_progress', 'review', 'done', 'failed', 'cancelled')),
  priority int not null default 0,
  parent_task_id uuid references public.tasks (id) on delete set null,
  result text,
  created_at timestamptz default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index tasks_queue_idx on public.tasks (status, priority desc, created_at);

-- Keep tasks.updated_at fresh.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- task_runs -------------------------------------------------------------------
create table public.task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed')),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- run_logs --------------------------------------------------------------------
create table public.run_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.task_runs (id) on delete cascade,
  seq bigint generated always as identity,
  level text not null default 'info'
    check (level in ('debug', 'info', 'warn', 'error')),
  event_type text not null
    check (event_type in ('system', 'assistant_text', 'tool_use', 'tool_result', 'status', 'error')),
  content jsonb not null default '{}',
  created_at timestamptz default now()
);

create index run_logs_run_seq_idx on public.run_logs (run_id, seq);

-- messages --------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  sender text not null check (sender in ('user', 'manager')),
  channel text not null default 'web' check (channel in ('web', 'telegram')),
  content text not null,
  created_at timestamptz default now()
);

create index messages_project_created_idx on public.messages (project_id, created_at);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Users (anon/authenticated key) can only reach rows under projects they own.
-- The worker uses the service role key, which bypasses RLS automatically.

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_repos enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.task_runs enable row level security;
alter table public.run_logs enable row level security;
alter table public.messages enable row level security;

-- profiles: user can read/update own row.
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- projects: owner full access.
create policy "projects_owner_all" on public.projects
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- workspaces: via parent project.
create policy "workspaces_owner_all" on public.workspaces
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = workspaces.project_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.projects p
      where p.id = workspaces.project_id and p.owner_id = auth.uid()
    )
  );

-- workspace_repos: via workspace -> project.
create policy "workspace_repos_owner_all" on public.workspace_repos
  for all using (
    exists (
      select 1
      from public.workspaces w
      join public.projects p on p.id = w.project_id
      where w.id = workspace_repos.workspace_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.workspaces w
      join public.projects p on p.id = w.project_id
      where w.id = workspace_repos.workspace_id and p.owner_id = auth.uid()
    )
  );

-- agents: via parent project.
create policy "agents_owner_all" on public.agents
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = agents.project_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.projects p
      where p.id = agents.project_id and p.owner_id = auth.uid()
    )
  );

-- tasks: via parent project.
create policy "tasks_owner_all" on public.tasks
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = tasks.project_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.projects p
      where p.id = tasks.project_id and p.owner_id = auth.uid()
    )
  );

-- task_runs: via task -> project.
create policy "task_runs_owner_all" on public.task_runs
  for all using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      where t.id = task_runs.task_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      where t.id = task_runs.task_id and p.owner_id = auth.uid()
    )
  );

-- run_logs: via run -> task -> project.
create policy "run_logs_owner_all" on public.run_logs
  for all using (
    exists (
      select 1
      from public.task_runs r
      join public.tasks t on t.id = r.task_id
      join public.projects p on p.id = t.project_id
      where r.id = run_logs.run_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1
      from public.task_runs r
      join public.tasks t on t.id = r.task_id
      join public.projects p on p.id = t.project_id
      where r.id = run_logs.run_id and p.owner_id = auth.uid()
    )
  );

-- messages: via parent project.
create policy "messages_owner_all" on public.messages
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = messages.project_id and p.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.projects p
      where p.id = messages.project_id and p.owner_id = auth.uid()
    )
  );

-- ===========================================================================
-- Queue claim RPC
-- ===========================================================================
-- Atomically claims the next queued task assigned to one of the given agents.
-- Highest priority first, then oldest. Uses FOR UPDATE SKIP LOCKED so multiple
-- workers can poll concurrently without double-claiming.
-- Returns the claimed task row, or null if the queue is empty.

create or replace function public.claim_next_task(p_agent_ids uuid[])
returns public.tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.tasks;
begin
  select * into v_task
  from public.tasks
  where status = 'queued'
    and agent_id = any (p_agent_ids)
  order by priority desc, created_at asc
  limit 1
  for update skip locked;

  if v_task.id is null then
    return null;
  end if;

  update public.tasks
  set status = 'in_progress',
      started_at = now()
  where id = v_task.id
  returning * into v_task;

  return v_task;
end;
$$;

-- ===========================================================================
-- Realtime
-- ===========================================================================

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.task_runs;
alter publication supabase_realtime add table public.run_logs;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.workspace_repos;
