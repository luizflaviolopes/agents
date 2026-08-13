-- 0005: PM & librarian foundation — time-of-day schedules, project-scoped
-- knowledge with provenance, the per-project librarian agent role, and
-- per-agent chat threads.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here. The `alter default privileges ... revoke` statements in 0002 apply
-- automatically to any new objects below, so the anon/authenticated keys
-- cannot touch them; only the service role (web API routes + worker) has
-- access.

-- ===========================================================================
-- schedules: time-of-day ('daily') schedules alongside interval schedules
-- ===========================================================================
-- kind 'interval' keeps the existing behavior (advance next_run_at by
-- interval_minutes). kind 'daily' fires at run_at_time (in `timezone`, an
-- IANA name; the UI sends the browser timezone) on the allowed `weekdays`
-- (0 = Sunday .. 6 = Saturday).

alter table public.schedules
  add column kind text not null default 'interval'
    check (kind in ('interval', 'daily'));

alter table public.schedules
  alter column interval_minutes drop not null;

alter table public.schedules
  add column run_at_time time;

alter table public.schedules
  add column weekdays smallint[] not null default '{0,1,2,3,4,5,6}';

alter table public.schedules
  add column timezone text not null default 'UTC';

-- Each kind requires its own timing column.
alter table public.schedules
  add constraint schedules_kind_fields_check check (
    (kind = 'interval' and interval_minutes is not null)
    or (kind = 'daily' and run_at_time is not null)
  );

-- ===========================================================================
-- agent_knowledge: project scoping + provenance
-- ===========================================================================
-- A doc is scoped to exactly one of (agent_id, project_id). Project-scoped
-- docs are injected into every agent of the project; agent-scoped docs only
-- into that agent. Provenance columns record which agent wrote/updated the
-- doc from which run; all null means human-authored via the UI.

alter table public.agent_knowledge
  add column project_id uuid references public.projects (id) on delete cascade;

alter table public.agent_knowledge
  alter column agent_id drop not null;

alter table public.agent_knowledge
  add constraint agent_knowledge_scope_check check (
    (agent_id is not null and project_id is null)
    or (agent_id is null and project_id is not null)
  );

alter table public.agent_knowledge
  add column created_by_agent_id uuid references public.agents (id) on delete set null;

alter table public.agent_knowledge
  add column updated_by_agent_id uuid references public.agents (id) on delete set null;

alter table public.agent_knowledge
  add column source_run_id uuid references public.task_runs (id) on delete set null;

create index agent_knowledge_project_idx
  on public.agent_knowledge (project_id)
  where project_id is not null;

-- ===========================================================================
-- agents: librarian role + activity cursor
-- ===========================================================================

-- 0001 created the role check inline, so it carries the auto-generated name.
alter table public.agents drop constraint agents_role_check;
alter table public.agents add constraint agents_role_check
  check (role in ('manager', 'specialist', 'librarian'));

-- Only one librarian agent per project (mirrors one_manager_per_project).
create unique index one_librarian_per_project
  on public.agents (project_id)
  where role = 'librarian';

-- High-water mark for the librarian's read_project_activity sweeps; the
-- worker advances it after a successful librarian run.
alter table public.agents
  add column activity_cursor timestamptz;

-- ===========================================================================
-- messages: per-agent chat threads
-- ===========================================================================
-- agent_id null = the project's manager thread (all existing behavior
-- unchanged); non-null = a direct chat thread with that agent.

alter table public.messages
  add column agent_id uuid references public.agents (id) on delete set null;

-- 0001 created the sender check inline, so it carries the auto-generated name.
alter table public.messages drop constraint messages_sender_check;
alter table public.messages add constraint messages_sender_check
  check (sender in ('user', 'manager', 'agent'));

create index messages_project_agent_created_idx
  on public.messages (project_id, agent_id, created_at);
