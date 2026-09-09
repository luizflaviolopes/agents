-- 0012: personal access tokens, so a client outside the browser can act as
-- the account owner.
--
-- Every entry point so far authenticates the same way: a Supabase session
-- cookie set by the browser at login. That works for the web UI and for
-- Telegram (which authenticates a chat id against profiles, not a request),
-- and it is exactly what an MCP client cannot produce. Claude Code running on
-- the owner's laptop has no cookie jar for this deployment, no login form to
-- fill, and no way to refresh a session — it has a config file with a header
-- in it. The fleet MCP endpoint (apps/web/src/app/api/mcp) is that client's
-- door, and this table is its key.
--
-- What is stored is a SHA-256 of the token, never the token. The plaintext is
-- returned exactly once, by the route that mints it, and is unrecoverable
-- afterwards — the same bargain every PAT makes, and the reason `hint` exists:
-- an owner staring at three tokens needs to tell them apart without being
-- shown any of them.
--
-- SHA-256 rather than bcrypt/argon2 is deliberate, and is the standard choice
-- for this shape of secret. Password hashes are slow because passwords are
-- low-entropy and guessable; a token minted here is 32 bytes from
-- crypto.randomBytes, so an attacker who has the hash has nothing to guess at.
-- Being fast is the point: verification happens on every MCP call and is a
-- single indexed lookup by hash, which also means no plaintext comparison ever
-- runs against a stored secret.
--
-- Scope is the whole account, on purpose. Narrowing it (this project only,
-- read only) is a real feature, but a half-built one is worse than none: the
-- owner would read the label and trust a boundary the code does not enforce.
-- The honest version is one scope — "everything you can do in the web UI" —
-- said plainly in the UI and the docs, with per-token revocation as the
-- control that actually works.
--
-- Authorization note: RLS is not used (see 0002). No policies are created
-- here; the `alter default privileges ... revoke` statements in 0002 apply
-- automatically to the objects below.

create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- What the owner named it ("laptop", "work desktop"). Not unique: two
  -- machines called "laptop" is a filing mistake, not a security problem.
  name text not null,
  -- SHA-256 (hex) of the plaintext token. Unique because a collision here
  -- would mean two accounts authenticated by one string.
  token_hash text not null unique,
  -- First few characters of the plaintext, for display. Enough to match a
  -- row against a token the owner still has, useless to anyone who does not.
  hint text not null,
  -- Optional expiry chosen at creation. Null = no expiry.
  expires_at timestamptz,
  -- Soft revocation. The row is kept so the hash stays claimed and the
  -- account's token history stays readable.
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Verification path: hash the presented token, look it up here. The unique
-- constraint above already indexes token_hash, so this index only serves the
-- settings list (a user's tokens, newest first).
create index api_tokens_user_created_idx
  on public.api_tokens (user_id, created_at desc);

comment on table public.api_tokens is
  'Personal access tokens authenticating non-browser clients (the fleet MCP endpoint) as the account owner. Full account scope; revoke per token.';
comment on column public.api_tokens.token_hash is
  'SHA-256 hex of the plaintext token. The plaintext is shown once at creation and never stored.';
comment on column public.api_tokens.hint is
  'Leading characters of the plaintext, shown in the UI so tokens can be told apart.';
