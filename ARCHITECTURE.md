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

Authorization lives in the **backend**, not in the database. Migration
`supabase/migrations/0002_backend_authz.sql` disabled RLS, dropped all
policies, and revoked every privilege on public tables/functions from the
`anon` and `authenticated` roles — so the anon key cannot read or write any
table (PostgREST and Realtime `postgres_changes` return nothing for it).

- **Browser Supabase client = auth only.** The `anon` key is used solely for
  signup, login, session refresh, and sign-out. All data access from the
  browser goes through the web app's `/api/*` route handlers.
- **Web server uses the service-role key.** API routes and server components
  read/write through a service-role client
  (`apps/web/src/lib/supabase/admin.ts`, guarded by `server-only`) and
  enforce ownership in application code: `requireUser()` reads the session
  from cookies, and `requireProjectAccess()` (plus workspace/repo/agent/task/
  run variants in `apps/web/src/lib/api/auth.ts`) walks every row up to its
  project and checks `projects.owner_id`.
- **The worker keeps using `SUPABASE_SERVICE_ROLE_KEY`** exactly as before
  (its Realtime subscriptions still work — service role is unaffected by the
  revokes).
- The web UI no longer subscribes to Realtime; it **polls** the API routes
  (see "Task queue" below).

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
`run_logs`, `messages`, `agents`, `workspace_repos` — only the **worker**
(service role) consumes it now, as a wake-up hint. The web UI **polls** its
own API routes instead: board tasks every 3s, chat messages every 2.5s
(incremental via `?after=<iso>`), repo clone statuses every 3s, activity
every 10s, and run logs every 2s (incremental via `?after=<seq>`, only while
the task dialog is open and the run is running) — all via the
`usePolling` hook in `apps/web/src/lib/use-polling.ts`, which pauses while
the tab is hidden.

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
   delivered over the originating channel (web via the chat panel's message
   polling, Telegram via `TELEGRAM_BOT_TOKEN`).

## API contracts

All web data access goes through route handlers under
`apps/web/src/app/api/`: `projects` (+`[id]`, and nested `workspaces`,
`agents`, `tasks`, `messages`, `activity`), `workspaces/[wsId]` (+`repos`),
`repos/[repoId]`, `agents/[agentId]`, `tasks/[taskId]` (+`runs`),
`runs/[runId]/logs`, `profile` (+`telegram-code`), and `agent-builder`.
Every route calls `requireUser()` and the relevant ownership check before
touching the database with the admin client.

Payload validation lives in `packages/shared/src/schemas.ts` (zod):
`createProjectSchema`, `createWorkspaceSchema`, `addWorkspaceRepoSchema`,
`createAgentSchema`, `createTaskSchema`, `sendMessageSchema`,
`agentBuilderRequestSchema` (update payloads are validated by local zod
schemas in the route files). API routes accept camelCase payloads and map to
snake_case columns. Constants: `DEFAULT_MODEL`, `TASK_STATUSES`,
`AGENT_ROLES` in `packages/shared/src/constants.ts`.

## Automations layer (migration 0003)

`supabase/migrations/0003_automations.sql` adds four tables (no RLS — the
0002 default-privilege revokes cover them; only the service role has access)
and extends `tasks.source` with `schedule` and `agent`.

- **schedules** — recurring task templates. The worker's schedule loop scans
  for rows where `enabled` and `next_run_at <= now()` (indexed on
  `(enabled, next_run_at)`), inserts a `tasks` row (`source = 'schedule'`,
  title/description from `task_title`/`task_description`, assigned to
  `agent_id`), then sets `last_run_at = now()` and advances `next_run_at` by
  `interval_minutes`.
- **pending_actions** — approval-gated outbound actions. Agents **never send
  anything directly**. Lifecycle: an agent proposes an action via the
  `propose_action` MCP tool (writes a row with `action_type`
  `slack_reply | slack_message | gmail_reply | gmail_send`, a human-readable
  `preview`, and the exact `payload` the executor will send —
  `SlackActionPayload` / `GmailActionPayload`) → the user approves or rejects
  it in the web Review inbox or via Telegram inline buttons
  (`status: pending → approved | rejected`, `decided_at` set; approval may
  include an edited payload — `decidePendingActionSchema`) → the worker's
  **deterministic executor** (plain code, no LLM) sends approved actions
  using the project's `integrations` credentials and sets
  `status: executed | failed` (`executed_at`, `error`).
- **agent_knowledge** — persistent docs injected into an agent's system
  prompt. All docs of an agent are prepended to its `instructions`; docs of
  `kind = 'voice'` are grouped under a "Voice profiles" heading. Multiple
  voices are supported — each voice doc should state WHO it is and WHEN it
  applies in its own content, so the agent can pick the right voice per
  message.
- **integrations** — per-project outbound credentials (`type: slack | gmail`,
  `config` jsonb, unique per `(project_id, type)`), used ONLY by the worker's
  deterministic action executor. LLM agents never hold send credentials —
  read-side credentials for MCP servers are configured per-agent via
  `agents.mcp_servers`, as before.
- **ask_agent subtask flow** — an agent tool that creates a child task for a
  named agent in the same project (`source = 'agent'`, `parent_task_id` set
  to the caller's task). The child is executed through the normal queue; the
  calling agent polls the child task for completion and reads its `result`.

`schedules` and `pending_actions` are in the `supabase_realtime` publication
(worker wake-up hints, same as `tasks`). Shared contract: row types
(`ScheduleRow`, `PendingActionRow`, `AgentKnowledgeRow`, `IntegrationRow`,
payload shapes) in `packages/shared/src/db-types.ts`; zod schemas
(`createScheduleSchema`, `updateScheduleSchema`, `decidePendingActionSchema`,
`createKnowledgeSchema`, `updateKnowledgeSchema`,
`slackIntegrationConfigSchema`, `gmailIntegrationConfigSchema`,
`upsertIntegrationSchema`) in `packages/shared/src/schemas.ts`; constant
arrays (`PENDING_ACTION_TYPES`, `PENDING_ACTION_STATUSES`,
`KNOWLEDGE_KINDS`, `INTEGRATION_TYPES`) in
`packages/shared/src/constants.ts`.

## Project management & librarian layer (migration 0005)

`supabase/migrations/0005_pm_librarian.sql` extends `schedules`,
`agent_knowledge`, `agents`, and `messages` (no RLS — the 0002 revokes
cover everything; only the service role has access).

### Daily schedules

`schedules.kind` is `'interval' | 'daily'` (default `'interval'`, existing
rows unchanged). A single check constraint (`schedules_kind_fields_check`)
requires `interval_minutes` for `'interval'` and `run_at_time` for
`'daily'`; `interval_minutes` is now nullable. New columns: `run_at_time`
(`time`, nullable), `weekdays` (`smallint[]`, default `{0,1,2,3,4,5,6}`,
0 = Sunday .. 6 = Saturday), `timezone` (`text`, default `'UTC'`, an IANA
name — the UI sends the browser timezone).

The worker's schedule loop is unchanged for `'interval'` rows. For
`'daily'` rows it computes `next_run_at` as the next occurrence of
`run_at_time` in the schedule's IANA `timezone` on an allowed weekday,
using `Intl`-based timezone math (`Intl.DateTimeFormat` with `timeZone`) —
no new dependencies.

Payloads: `createScheduleSchema` is now `{ projectId, agentId, name, kind,
intervalMinutes?, runAtTime? ("HH:MM"), weekdays? (default all), timezone?
(default 'UTC'), taskTitle, taskDescription?, enabled? }` with a refinement
enforcing the kind/field pairing; `updateScheduleSchema` is the partial
minus `projectId`, with the same refinement applied when `kind` is present.
Constants: `SCHEDULE_KINDS`, `WEEKDAY_LABELS` (Sun..Sat, indexed by the
`weekdays` values).

### Per-agent chat

`messages.agent_id` (nullable, `on delete set null`) selects the chat
thread: **NULL = the project's manager thread** — the entire existing flow
is unchanged — and non-null = a direct thread with that agent. The sender
check is widened to `('user', 'manager', 'agent')`. New index:
`messages_project_agent_created_idx (project_id, agent_id, created_at)`.
`sendMessageSchema` gains an optional `agentId` (uuid) targeting the
thread.

The worker's message listener routes a user message with a non-null
`agent_id` to that agent and runs it with its OWN `mcp_servers` +
knowledge + a `reply_to_user` tool, injecting the last 20 messages of THAT
thread as conversation context. Specialist/librarian chat sessions get
their normal toolset (`propose_action`, `ask_agent`, notify-related) —
the same guardrails as task runs.

### notify_user tool

Available to ALL agents, in task runs AND chat sessions: inserts a
`messages` row (`sender = 'agent'`, `agent_id` = the calling agent,
`channel = 'web'`) and mirrors the text to the owner's Telegram if
`profiles.telegram_chat_id` is linked. It is NOT approval-gated — it only
talks to the project owner, never to external systems (those remain behind
`pending_actions`).

### Knowledge scoping & provenance

`agent_knowledge` rows are scoped to **exactly one** of `agent_id` /
`project_id` (check constraint `agent_knowledge_scope_check`; `agent_id`
is now nullable, `project_id` references `projects` with cascade; partial
index `agent_knowledge_project_idx` on `project_id`). System prompt
injection = the project-scoped docs (shared by all agents of the project)
+ the agent's own agent-scoped docs; `kind = 'voice'` docs remain
agent-scoped only (enforced by `createKnowledgeSchema`).

Provenance columns (all nullable, `on delete set null`):
`created_by_agent_id`, `updated_by_agent_id` (references `agents`), and
`source_run_id` (references `task_runs`) record which agent wrote a doc
from which run. All-null = human-authored via the UI; a human edit nulls
out `updated_by_agent_id`.

`createKnowledgeSchema` is now `{ scope: 'agent' | 'project', agentId?,
projectId?, kind, title, content }` — the id matching `scope` is required;
`updateKnowledgeSchema` stays scope-immutable (partial `kind`/`title`/
`content`).

### Librarian

A new agent role `'librarian'` (`agents_role_check` widened; partial
unique index `one_librarian_per_project` enforces at most one per
project, mirroring `one_manager_per_project`). The librarian curates all
knowledge for its project. Only librarians get two extra tools:

- `save_knowledge({ scope: 'project' | 'agent', agent_name?, title,
  content, mode: 'create' | 'replace' | 'append' })` — for
  `replace`/`append` it matches the existing doc by scope + title; every
  write sets the provenance columns (`created_by_agent_id` /
  `updated_by_agent_id` / `source_run_id`).
- `read_project_activity({ since? })` — returns messages + finished tasks
  (with results) across the project since the given timestamp or the
  stored cursor, as compact JSON. `agents.activity_cursor` (timestamptz,
  nullable, added in 0005) is the high-water mark; the worker advances it
  after a successful librarian run.

ALL agents' standard preamble gains this rule: durable facts learned in
conversation must be forwarded to the project's librarian via `ask_agent`
(if a librarian exists).

Shared contract: `ScheduleKind`, updated `ScheduleRow` /
`AgentKnowledgeRow` / `AgentRole` / `Agent.activity_cursor` /
`Message.agent_id` / `MessageSender` in
`packages/shared/src/db-types.ts`; `createScheduleSchema`,
`updateScheduleSchema`, `createKnowledgeSchema`, `updateKnowledgeSchema`,
`sendMessageSchema` in `packages/shared/src/schemas.ts`; `AGENT_ROLES`
(now includes `librarian`), `SCHEDULE_KINDS`, `WEEKDAY_LABELS` in
`packages/shared/src/constants.ts`.

## Environment

See `.env.example`: Supabase URL/keys, `ANTHROPIC_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `WORKSPACES_ROOT`, `WEB_URL`.
`SUPABASE_SERVICE_ROLE_KEY` is required by **both** the web server (API
routes / server components) and the worker — it must never reach the
browser.
