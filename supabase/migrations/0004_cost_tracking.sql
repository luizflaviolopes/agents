-- 0004: Per-agent cost tracking on task_runs.
--
-- The worker populates these columns from the Agent SDK result message at the
-- end of every run (success or error): `modelUsage` per-model totals when
-- present (summed; `model` is the key with the largest costUSD), otherwise
-- the top-level `usage` + `total_cost_usd`, with `model` falling back to the
-- agent's configured model. All columns stay null when the run crashed before
-- a result message arrived.
--
-- Authorization note: RLS is not used (see 0002); only the service role
-- (web API routes + worker) can touch task_runs.

alter table public.task_runs
  add column model text,
  add column input_tokens bigint,
  add column output_tokens bigint,
  add column cache_read_tokens bigint,
  add column cache_creation_tokens bigint,
  add column cost_usd numeric(12, 6);

comment on column public.task_runs.cost_usd is
  'Estimated USD cost of the run, populated by the worker from the Agent SDK result message (null if the run crashed before a result).';

-- Per-agent period aggregation (the costs API groups runs by agent over
-- started_at windows).
create index task_runs_agent_started_idx
  on public.task_runs (agent_id, started_at desc);
