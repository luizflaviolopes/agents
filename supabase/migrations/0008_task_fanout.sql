-- 0008: asynchronous fan-out and fan-in for agent-spawned work.
--
-- ask_agent is synchronous: the caller blocks on one child task, and the SDK
-- executes in-process MCP tool calls one at a time, so N ask_agent calls run
-- strictly in sequence — each under the ask_agent timeout, all inside the
-- caller's single run and context window. That makes it unusable for fanning a
-- ticket out over its pull requests.
--
-- spawn_tasks (apps/worker/src/runner/session.ts) inserts the children and
-- returns immediately, so they run through the normal queue at the worker's
-- full concurrency. The caller's run then ends without their results — the
-- fan-in trigger below is what brings the work back together.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

-- ===========================================================================
-- tasks.source: 'fanout' and 'fanin'
-- ===========================================================================
-- 'fanout' — a child task created by spawn_tasks. Distinct from 'agent'
-- (ask_agent children) precisely so the fan-in trigger can tell them apart: an
-- ask_agent parent is still running and blocking on its child, so aggregating
-- its siblings would re-run an agent that never asked for it.
--
-- 'fanin' — the aggregation task the worker enqueues once the last 'fanout'
-- sibling of a parent finishes. Assigned to the parent's own agent, carrying
-- the children's results. It is excluded from triggering another fan-in, which
-- is what terminates the chain (a 'fanin' task is itself a child of the same
-- parent, so without that exclusion it would re-trigger on its own completion).

alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in (
    'web', 'telegram', 'manager', 'system', 'schedule', 'agent', 'trigger',
    'fanout', 'fanin'
  ));

-- ===========================================================================
-- The fan-in invariant, enforced by the database
-- ===========================================================================
-- At most one QUEUED aggregation per parent. Two workers finishing the last
-- two siblings in the same instant both count "zero unfinished" and both
-- insert; this index makes the loser fail with 23505 (unique_violation), which
-- the worker reads as "already queued" — the same settlement 0006 uses for
-- knowledge sweeps.
--
-- Only 'queued' is constrained: an aggregation that is already running has
-- read its children's results, so a later batch may legitimately queue behind
-- it.

create unique index one_queued_fanin_per_parent
  on public.tasks (parent_task_id)
  where status = 'queued' and source = 'fanin';

-- The trigger asks "are any siblings of this task still unfinished?" —
-- filtered by parent + status. tasks_queue_idx is on (status, priority desc,
-- created_at) and tasks_project_agent_status_idx (0006) on (project_id,
-- agent_id, status); neither serves that shape.

create index tasks_parent_status_idx
  on public.tasks (parent_task_id, status)
  where parent_task_id is not null;
