-- 0006: coalesced post-run knowledge sweeps.
--
-- Until now the librarian only swept on its schedule (plus the facts other
-- agents forwarded via ask_agent), so a fact learned in a task run waited
-- until the next scheduled sweep to reach the knowledge docs. The worker now
-- enqueues a sweep as soon as an agent run finishes — coalesced, so a busy
-- fleet produces one sweep per burst instead of one per run, and sweeps never
-- overlap (overlapping sweeps would race on the same docs, since
-- save_knowledge is a read-then-write with no version check).
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

-- ===========================================================================
-- tasks.source: 'trigger'
-- ===========================================================================
-- A sweep task enqueued by the worker's post-run trigger. Distinct from
-- 'schedule' (the schedule loop), 'system' (web-created automation) and
-- 'agent' (ask_agent child tasks).

alter table public.tasks drop constraint tasks_source_check;
alter table public.tasks add constraint tasks_source_check
  check (source in ('web', 'telegram', 'manager', 'system', 'schedule', 'agent', 'trigger'));

-- ===========================================================================
-- The coalescing invariant, enforced by the database
-- ===========================================================================
-- At most one QUEUED trigger sweep per project. The worker checks before
-- inserting, but two workers finishing runs in the same instant both see
-- "nothing queued" and both insert; this index makes the loser fail with
-- 23505 (unique_violation), which the worker reads as "already queued".
--
-- Only 'queued' is constrained: a sweep that is already running has read its
-- activity window, so a follow-up is legitimately allowed to queue behind it.

create unique index one_queued_sweep_per_project
  on public.tasks (project_id)
  where status = 'queued' and source = 'trigger';

-- The trigger's pre-insert check asks "is a librarian task queued or running
-- in this project?" — filtered by project + agent + status. The existing
-- tasks_queue_idx is on (status, priority desc, created_at), which does not
-- serve that shape.

create index tasks_project_agent_status_idx
  on public.tasks (project_id, agent_id, status);
