-- 0013: per-agent authentication mode — API key or local Claude Code
-- subscription.
--
-- The worker has always run agents through the Claude Agent SDK, which is the
-- Claude Code harness spawned as a subprocess on the worker machine. What
-- decides whether a run bills the Anthropic API is not the transport but the
-- credential that subprocess authenticates with: ANTHROPIC_API_KEY reaches it
-- through buildAgentEnv (which keeps ANTHROPIC_*/CLAUDE_* on purpose), and an
-- API key outranks any OAuth credential the machine has stored.
--
-- 'subscription' drops the API credentials from that one subprocess's
-- environment, leaving the Claude Code OAuth credentials on the worker box
-- (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or the login stored
-- under ~/.claude) as the only thing left to authenticate with. The run then
-- draws on the subscription's quota instead of the API balance.
--
-- Why per agent rather than one global switch: the two modes fail in
-- different ways. API billing degrades by costing more; a subscription is
-- metered in rolling windows sized for one interactive human, so a fleet that
-- exhausts them stalls every agent at once, mid-task. Putting bulk work
-- (librarian sweeps, ticket review) on the subscription and leaving
-- latency- or reliability-critical agents on the API is the only arrangement
-- that gets the saving without making the whole fleet share one failure.
--
-- Default 'api' so every existing agent keeps its current behaviour; the
-- switch is opt-in per agent. To move a whole project across at once:
--   update public.agents set auth_mode = 'subscription' where project_id = '...';
--
-- Note that a run's dollar cost is only meaningful under 'api'. Subscription
-- runs record their token counts as usual but leave task_runs.cost_usd null —
-- writing 0 there would read as "this run was free" in the costs dashboard
-- rather than "this run was not billed per token".
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

alter table public.agents
  add column auth_mode text not null default 'api'
    check (auth_mode in ('api', 'subscription'));

comment on column public.agents.auth_mode is
  'Credential the agent''s Claude Code subprocess authenticates with: ''api'' (ANTHROPIC_API_KEY, billed per token) or ''subscription'' (the worker machine''s Claude Code login, billed against its quota).';
