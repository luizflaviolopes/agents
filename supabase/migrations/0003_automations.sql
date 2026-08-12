-- 0003: Automations layer — schedules, approval-gated pending actions,
-- agent knowledge docs, and per-project outbound integrations.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here. The `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the new tables/sequences below, so the anon/authenticated
-- keys cannot touch them; only the service role (web API routes + worker)
-- has access.

-- ===========================================================================
-- Tables
-- ===========================================================================

-- schedules -------------------------------------------------------------------
-- Recurring task templates. The worker inserts a task whenever next_run_at
-- is due, then advances next_run_at by interval_minutes.
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  name text not null,
  interval_minutes int not null check (interval_minutes >= 1),
  task_title text not null,
  task_description text not null default '',
  enabled boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz default now()
);

create index schedules_due_idx on public.schedules (enabled, next_run_at);

-- pending_actions ---------------------------------------------------------------
-- Approval-gated outbound actions proposed by agents. An agent never sends
-- anything directly: it proposes an action here, the user approves or rejects
-- it, and only then does the worker's deterministic executor send it.
create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  agent_id uuid references public.agents (id) on delete set null,
  action_type text not null
    check (action_type in ('slack_reply', 'slack_message', 'gmail_reply', 'gmail_send')),
  -- Human-readable summary shown for approval.
  preview text not null,
  -- Exact data the executor will send (SlackActionPayload / GmailActionPayload).
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'executed', 'failed')),
  error text,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz default now()
);

create index pending_actions_project_status_idx
  on public.pending_actions (project_id, status, created_at desc);

-- agent_knowledge ---------------------------------------------------------------
-- Persistent docs injected into an agent's system prompt. kind 'voice' docs
-- describe a writing voice (who/when it applies lives in the content).
create table public.agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  kind text not null default 'knowledge'
    check (kind in ('knowledge', 'voice')),
  title text not null,
  content text not null default '',
  created_at timestamptz default now(),
  updated_at timestamptz not null default now()
);

create trigger agent_knowledge_set_updated_at
  before update on public.agent_knowledge
  for each row execute function public.set_updated_at();

-- integrations ------------------------------------------------------------------
-- Per-project outbound credentials, used ONLY by the worker's deterministic
-- action executor. LLM agents never see these (their read-side MCP servers
-- are configured per-agent as before).
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  type text not null check (type in ('slack', 'gmail')),
  config jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, type)
);

create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- tasks.source: allow 'schedule' and 'agent'
-- ===========================================================================

alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in ('web', 'telegram', 'manager', 'system', 'schedule', 'agent'));

-- ===========================================================================
-- Realtime
-- ===========================================================================

alter publication supabase_realtime add table public.schedules;
alter publication supabase_realtime add table public.pending_actions;
