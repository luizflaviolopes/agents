-- 0011: a durable claim on user messages, so one message is handled once.
--
-- The manager listener consumes a user message twice over: Realtime delivers
-- the INSERT, and a 10s poll sweeps anything Realtime dropped. Both paths feed
-- ManagerListener.enqueue, which de-duplicates against an in-memory Set of
-- message ids. That Set is per-process, and it is the ONLY thing standing
-- between a message and a second manager session.
--
-- So the invariant held only as long as exactly one worker was running. The
-- moment a second listener existed anywhere on this project — a local dev
-- worker sharing the hosted .env, a deploy whose predecessor had not yet
-- drained, a container restarted alongside its own replacement — each one saw
-- the INSERT, each one missed the other's in-memory Set, and each one ran a
-- full manager session. Observed 2026-08-18: one "review the ticket" message
-- produced two identical Ticket Reviewer tasks 81ms apart, each with its own
-- chat reply describing "the" task it had created, and both then burned an
-- Opus run on the same review.
--
-- The fix is the settlement this schema already uses twice — let the database
-- decide the winner, and let the loser find out by getting nothing back:
--
--   * 0006, one_queued_sweep_per_project: the loser's insert raises 23505.
--   * 0008, one_queued_fanin_per_parent:  same, for fan-in aggregation.
--
-- A partial unique index does not fit here, because the contended row already
-- exists — there is no second insert to reject. The equivalent primitive for
-- an existing row is a conditional UPDATE, which Postgres settles just as
-- firmly. Under read-committed, two workers running
--
--     update messages set handled_at = now() where id = $1 and handled_at is null
--
-- against the same row do not both succeed: the second blocks on the first's
-- row lock, and when the first commits, re-evaluates its WHERE clause against
-- the updated row (EvalPlanQual). handled_at is no longer null, so the second
-- matches nothing and reports zero rows affected. "Zero rows" is the loser's
-- signal, exactly as 23505 is in 0006 and 0008.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

-- ===========================================================================
-- messages.handled_at
-- ===========================================================================
-- When a worker claimed this message for handling — NOT when it finished, and
-- not a general-purpose "read" marker. Only user messages are ever claimed;
-- the manager and agent replies the listener writes are never consumed by it,
-- so their handled_at stays null and means nothing.
--
-- The claim is permanent, with no lease or expiry. That is deliberate, and it
-- preserves today's semantics rather than widening them: a manager session that
-- crashes mid-flight is already never retried (its id stays in the in-memory
-- Set, and lastSeenCreatedAt has moved past it), and handleUserMessage already
-- catches its own failures and answers the user. A lease would hand the message
-- to a second worker whenever a session outran the timeout — which is the
-- duplicate this migration exists to prevent, reintroduced on a timer.

alter table public.messages add column handled_at timestamptz;

-- Every message that predates this column has already been handled (or missed
-- for good — lastSeenCreatedAt starts at process boot, so anything that
-- arrived while no worker was running was never picked up and will not be now).
-- Either way it must not read as unclaimed work: a later change that trusts
-- `handled_at is null` to mean "needs handling" would otherwise wake up to the
-- project's entire message history queued for the manager.
--
-- created_at, not now(): these were handled when they arrived, and stamping the
-- migration's clock on them would misdate the record.

update public.messages
   set handled_at = created_at
 where sender = 'user' and handled_at is null;

-- No index is added for this column. The claim is a primary-key UPDATE, which
-- is already served, and nothing queries for unclaimed messages — the poll
-- still selects on (sender, created_at) through messages_project_created_idx.
-- A partial index on `where sender = 'user' and handled_at is null` is what a
-- backlog-recovery poll would want, and belongs with that change, not here.
