-- 0014: the account owner's Claude Code subscription token, stored on their
-- profile and pasted from Settings.
--
-- 0013 gave each agent an auth_mode, but left the 'subscription' credential
-- where the worker process could reach it: CLAUDE_CODE_OAUTH_TOKEN in the
-- worker's environment, or the Claude Code login under ~/.claude on the worker
-- box. Both are deploy-time configuration. An OAuth token is not deploy-time
-- anything — it is rotated, revoked and re-issued on a schedule that has
-- nothing to do with shipping code, and rotating it meant editing .env on the
-- server and recreating the worker container (an --env-file is read when the
-- container is CREATED, so a restart would keep serving the old value). That
-- put a routine credential change behind SSH access and killed whatever runs
-- were in flight.
--
-- Owner-scoped rather than one value for the deployment. The quota being spent
-- belongs to a person's Claude subscription, not to the machine: whoever owns
-- the project is who the runs are billed to, and on a deployment with more
-- than one account a single shared token would quietly bill one person for
-- everyone else's agents.
--
-- The token is stored as given, not hashed. api_tokens (0012) can hash because
-- the fleet only ever needs to RECOGNISE a token someone presents; this one has
-- to be REPLAYED into an agent subprocess, so a one-way function is not
-- available. That is the same bargain agents.mcp_servers already makes for
-- per-server credentials, and it rests on the same control: no table here is
-- readable by the anon or authenticated roles (0002 revoked that), so reaching
-- this column means holding the service key, which is full database access
-- anyway.
--
-- What protects it beyond that is what is NOT selected. The hint column exists
-- so the UI and the API can show the owner which token is saved without the
-- plaintext leaving the server: every server-side read of profiles selects an
-- explicit column list that omits claude_code_oauth_token (see
-- PROFILE_SUMMARY_COLUMNS in apps/web/src/lib/api/profile.ts), the same
-- discipline 0012 applies to token_hash.
--
-- Resolution order at run time (apps/worker/src/lib/agent-env.ts): this column
-- first, then CLAUDE_CODE_OAUTH_TOKEN from the worker environment, then the
-- login under ~/.claude. Existing deployments therefore keep working untouched
-- — the column is null for every current profile, and the env var they already
-- set still answers.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

alter table public.profiles
  add column claude_code_oauth_token text,
  add column claude_code_token_hint text,
  add column claude_code_token_set_at timestamptz;

comment on column public.profiles.claude_code_oauth_token is
  'Claude Code OAuth token (from `claude setup-token`) injected as CLAUDE_CODE_OAUTH_TOKEN into the subprocess of this owner''s agents with auth_mode ''subscription'' (0013). Stored in plaintext because it must be replayed, not recognised; never select it into a response.';

comment on column public.profiles.claude_code_token_hint is
  'Leading and trailing characters of the saved token, so the owner can tell which one is stored without it being shown.';

comment on column public.profiles.claude_code_token_set_at is
  'When the saved token was last replaced. Shown in Settings so an aging token is visible before it expires.';
