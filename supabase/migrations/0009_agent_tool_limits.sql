-- 0009: per-agent limits on the SDK's built-in tools.
--
-- Agents run with permissionMode 'bypassPermissions', so until now their
-- instructions were the only thing standing between them and any built-in tool
-- (Bash, Write, Edit, WebFetch...). An agent whose whole job is reading
-- attacker-influenced text — ticket bodies, pull request descriptions, diffs —
-- should not be one prompt injection away from a shell.
--
-- allowed_tools maps to the SDK's `tools` option (the base set of built-in
-- tools available at all) and disallowed_tools to `disallowedTools` (removed
-- from the model's context entirely). Deliberately NOT the SDK's `allowedTools`
-- option — that one only auto-approves prompts, which is meaningless under
-- bypassPermissions. These are capability gates, not instructions: no prompt
-- can talk its way past them.
--
-- Empty array = unrestricted, so every existing agent keeps its current
-- behaviour. An empty allow-list must therefore be omitted at the call site
-- rather than passed as `tools: []`, which would disable every built-in tool.
--
-- Names are the SDK's tool names ("Bash", "Write", "Edit", "WebFetch"). The
-- fleet MCP tools (notify_user, ask_agent, spawn_tasks...) are not built-ins
-- and stay available regardless.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

alter table public.agents
  add column allowed_tools jsonb not null default '[]'::jsonb,
  add column disallowed_tools jsonb not null default '[]'::jsonb;

comment on column public.agents.allowed_tools is
  'Built-in tool allow-list passed to the Agent SDK. Empty = no allow-list (every tool permitted unless disallowed).';
comment on column public.agents.disallowed_tools is
  'Built-in tool deny-list passed to the Agent SDK. Applied on top of allowed_tools.';
