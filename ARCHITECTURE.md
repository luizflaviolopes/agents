# Agent Fleet — Architecture

Agent Fleet is a self-hosted platform where a user creates **projects**, each
containing **workspaces** (folders of cloned GitHub repos on the worker's disk)
and **agents** (Claude Agent SDK runtimes). Each project has exactly one
**manager** agent that receives user requests (web chat or Telegram) and
creates/distributes tasks to specialist agents via a Postgres-backed queue.

Stack: Next.js 15 (web UI), Node worker service, Supabase (Auth + Postgres +
Realtime), Docker deploy to a VPS.

## Domain model

All tables live in `supabase/migrations/0001_init.sql`; row types and enum
unions live in `packages/shared/src/db-types.ts`. Keep both in sync.

- **profiles** — one per auth user (auto-created by trigger on
  `auth.users` insert). Holds `telegram_chat_id` / `telegram_link_code` for
  linking a Telegram account.
- **projects** — owned by a user (`owner_id`). The unit of access control.
- **workspaces** — belong to a project. `path` is a slugified folder name on
  the worker's disk. Unique `(project_id, name)`.
- **workspace_repos** — a GitHub repo cloned into a workspace, pinned to one
  `branch`, placed in `folder_name`. `clone_status`:
  `pending | cloning | ready | error`. Unique `(workspace_id, folder_name)`.
- **agents** — belong to a project, optionally to a workspace
  (`workspace_id` nullable, `on delete set null`). `role`:
  `manager | specialist`; a partial unique index (`one_manager_per_project`)
  enforces at most one manager per project. Config columns: `instructions`
  (system prompt), `model` (default `claude-sonnet-5`), `plugins` (jsonb
  string array), `mcp_servers` (jsonb array of `McpServerConfig`), `is_active`.
- **tasks** — the queue. `status`:
  `queued | in_progress | review | done | failed | cancelled`. `source`:
  `web | telegram | manager | system`. `agent_id` is the assignee;
  `parent_task_id` links manager-created subtasks; `priority` int (higher
  first); `result` holds the final text output. `updated_at` maintained by
  trigger.
- **task_runs** — one row per execution attempt of a task. `status`:
  `running | succeeded | failed`.
- **run_logs** — append-only log of everything an agent does during a run.
  `seq` (identity) orders events within a run. `event_type`:
  `system | assistant_text | tool_use | tool_result | status | error`;
  `content` is the raw jsonb payload.
- **messages** — project chat between `user` and `manager`, over channel
  `web | telegram`, optionally linked to a task.

### Security

RLS is enabled on every table. The browser (anon key) can only reach rows
whose parent project is owned by `auth.uid()` (enforced with `exists`
subqueries up the chain: run_logs → task_runs → tasks → projects, etc.).
The worker uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.

## Monorepo layout

```
agent-fleet/
├── apps/
│   ├── web/       # Next.js 15 app: auth, project/workspace/agent CRUD, chat, task board, log viewer
│   └── worker/    # Node service: queue consumer, agent runtime (Claude Agent SDK), Telegram bot, repo cloning
├── packages/
│   └── shared/    # @agent-fleet/shared — DB row types, zod API schemas, constants (TS source, no build step)
└── supabase/      # config.toml + SQL migrations
```

- pnpm workspaces (`apps/*`, `packages/*`) + turbo (`dev`, `build`, `lint`,
  `typecheck`).
- `@agent-fleet/shared` ships raw TypeScript (`main`/`exports` point at
  `src/index.ts`). Next.js consumes it via `transpilePackages:
  ["@agent-fleet/shared"]`; the worker runs through `tsx`, which handles TS
  imports natively. Import as `import { createTaskSchema, DEFAULT_MODEL } from
  "@agent-fleet/shared"`.

## Task queue

1. A task is inserted with `status = 'queued'` and an `agent_id` (by the web
   API, the Telegram bot, or the manager agent).
2. The worker knows which agents it hosts and calls the RPC
   `claim_next_task(p_agent_ids uuid[])` — `SECURITY DEFINER`, picks the
   highest-`priority`, oldest `queued` task where
   `agent_id = any(p_agent_ids)` using `FOR UPDATE SKIP LOCKED`, flips it to
   `in_progress` + `started_at = now()`, and returns the row (or null).
   Multiple workers can poll safely; nothing is double-claimed.
3. The worker subscribes to Supabase Realtime on `tasks` inserts as a wake-up
   signal and also polls on an interval as a fallback — Realtime is a hint,
   the RPC is the source of truth.
4. On claim, the worker inserts a `task_runs` row, executes the agent, then
   sets the run to `succeeded`/`failed` and the task to `done`/`failed`
   (`finished_at`, `result`).

Realtime publication (`supabase_realtime`) includes: `tasks`, `task_runs`,
`run_logs`, `messages`, `agents`, `workspace_repos` — the web UI live-updates
task boards, log streams, and chat from these.

## Workspaces on disk

- Layout: `WORKSPACES_ROOT/<workspace_id>/<repo folder_name>` (default root
  `./workspaces-data`, gitignored; a Docker volume in production).
- When a `workspace_repos` row is created, the worker sets
  `clone_status = 'cloning'` and runs
  `git clone --branch <branch> --single-branch <repo_url> <folder_name>`
  inside `WORKSPACES_ROOT/<workspace_id>/`, using `GITHUB_TOKEN` for private
  repos. On success `clone_status = 'ready'`; on failure `'error'` with the
  message in `error`.

## Agent runtime

For each claimed task the worker runs the Claude Agent SDK `query()` with:

- `systemPrompt` = `agent.instructions`
- `model` = `agent.model` (default `claude-sonnet-5`)
- `cwd` = the agent's workspace directory
  (`WORKSPACES_ROOT/<workspace_id>`) when `workspace_id` is set
- `mcpServers` built from `agent.mcp_servers`
  (`{name, type: 'stdio'|'http'|'sse', command?, args?, url?, env?}`)
- prompt = the task's `title` + `description`

Every event from the SDK stream is written to `run_logs` (`run_id`, `seq`
auto-increments, `level`, `event_type`, raw `content` jsonb) — this is the
debugging record for everything an agent does.

## Manager flow

1. User sends a message (web chat, or Telegram routed via
   `profiles.telegram_chat_id`). It is stored in `messages`
   (`sender = 'user'`) and dispatched to the project's manager agent.
2. The manager agent runs like any agent but is additionally given
   task-management tools (create task, assign agent, list agents/tasks). It
   decomposes the request into `tasks` rows (`source = 'manager'`,
   `parent_task_id` set for subtasks) assigned to specialist agents.
3. Workers claim and execute those tasks through the normal queue.
4. Manager replies are stored in `messages` (`sender = 'manager'`) and
   delivered over the originating channel (web via Realtime, Telegram via
   `TELEGRAM_BOT_TOKEN`).

## API contracts

Payload validation lives in `packages/shared/src/schemas.ts` (zod):
`createProjectSchema`, `createWorkspaceSchema`, `addWorkspaceRepoSchema`,
`createAgentSchema`, `createTaskSchema`, `sendMessageSchema`,
`agentBuilderRequestSchema`. API routes accept camelCase payloads and map to
snake_case columns. Constants: `DEFAULT_MODEL`, `TASK_STATUSES`,
`AGENT_ROLES` in `packages/shared/src/constants.ts`.

## Environment

See `.env.example`: Supabase URL/keys, `ANTHROPIC_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `WORKSPACES_ROOT`, `WEB_URL`.
