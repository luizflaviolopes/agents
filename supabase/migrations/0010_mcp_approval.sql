-- 0010: approval-gated MCP tool calls, and github/notion as write integrations.
--
-- Until now the only outbound actions an agent could not take by itself were
-- Slack messages and emails, because those were the only ones the
-- pending_actions machinery had types for. Everything else an agent could
-- reach — a GitHub MCP server, a Notion MCP server — it called inline, with
-- whatever credential sat in agents.mcp_servers. That credential is in the
-- agent's own session, and agents read text written by people who are not the
-- project owner (issue bodies, PR descriptions, Slack threads, Notion pages),
-- so "the agent has the write token" means "anything the agent reads can spend
-- the write token".
--
-- The fix is the pattern that already exists, generalised rather than copied:
--
--   1. Each entry in agents.mcp_servers gains an approval policy
--      (`approval: 'never' | 'ask'`, plus `askTools` and `integration`). It
--      lives in the existing jsonb column, so there is no DDL for it here —
--      see McpServerConfig in packages/shared/src/db-types.ts.
--   2. A PreToolUse hook in the worker denies gated tool calls in-session and
--      tells the agent to propose them instead.
--   3. `propose_tool_call` queues a pending_action of the new type
--      'mcp_tool_call', whose payload names the server, the tool and the
--      frozen arguments.
--   4. After approval, the worker's deterministic executor opens its OWN MCP
--      client to that server and makes the call. No model in the loop.
--   5. When the server names an `integration`, the executor authenticates with
--      the write credential from `integrations` instead of the one in
--      mcp_servers — so the agent can hold a read-only token and the write
--      token never enters an LLM session at all.
--
-- One action type, one executor path, any MCP server: gating a new server is
-- configuration, not code.
--
-- Deliberately NOT solved here: an approved call ends the run at 'review', so
-- the agent never sees the tool's return value. That is fine for a send and
-- awkward mid-workflow ("create the page, then add children to it"). The
-- convention is that agents do gated writes last; the returned text is
-- recorded in the project chat so the owner (and a later run) can see it.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the privilege revokes in 0002 already cover these tables.

-- ===========================================================================
-- pending_actions.action_type: drop the CHECK rather than widen it
-- ===========================================================================
-- This constraint has to be edited every time a new kind of outbound action is
-- added, which is a migration per action type for no safety that isn't already
-- enforced above it: nothing but the web API and the worker can write this
-- table (0002 revoked every privilege from anon/authenticated), both write
-- action_type from the PendingActionType union in packages/shared, and the
-- executor already fails an action it cannot route. The status CHECK below is
-- left in place on purpose — that set is a closed lifecycle, not a growing
-- catalogue.
alter table public.pending_actions drop constraint pending_actions_action_type_check;

comment on column public.pending_actions.action_type is
  'Kind of outbound action. Unconstrained in the database on purpose (0010): the gate is the PendingActionType union in packages/shared plus the executor''s routing, and the table is only writable by the service role.';

comment on column public.pending_actions.payload is
  'Exact data the executor will send: SlackActionPayload | GmailActionPayload | McpToolCallActionPayload, per action_type. Frozen at proposal time; for mcp_tool_call it is never edited on approval, so what the owner reviewed is what gets sent.';

-- ===========================================================================
-- integrations.type: allow 'github' and 'notion'
-- ===========================================================================
-- Kept as a CHECK, unlike action_type above: this set mirrors
-- INTEGRATION_TYPES and grows once per external system rather than once per
-- action, and each value is a place the executor looks for a credential.
alter table public.integrations drop constraint integrations_type_check;
alter table public.integrations add constraint integrations_type_check
  check (type in ('slack', 'gmail', 'github', 'notion'));

comment on column public.integrations.config is
  'jsonb credentials, read ONLY by the worker. slack/gmail: the sender config for their hand-written executors. github/notion: McpIntegrationConfig — the write token the executor attaches to its own MCP connection, plus where it goes (headerName for http/sse, envVar for stdio).';
