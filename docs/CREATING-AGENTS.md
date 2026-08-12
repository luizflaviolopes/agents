# Creating Agents

An agent is a row in the `agents` table: a name, a role (`manager` or
`specialist` — one manager per project, enforced by the database), an optional
workspace, and four config fields the worker feeds into every Claude Agent SDK
run:

| Field | What it does |
|---|---|
| `instructions` | The agent's system prompt |
| `model` | Claude model id (default `claude-sonnet-5`) |
| `mcp_servers` | Extra tools via MCP servers (see below) |
| `plugins` | Free-form capability tags (roadmap — see below) |

When a task is claimed for an agent, the worker runs the SDK with
`systemPrompt = instructions`, `cwd` = the agent's workspace directory (if it
has one), and the task's title + description as the prompt. The agent has the
SDK's standard tools — shell, file read/write, search — inside that directory.

## Writing good instructions

Instructions are a system prompt, and the same rules apply. Four ingredients:

1. **Role** — who the agent is, in one or two sentences. Anchor its expertise
   and tone.
2. **Scope** — what it should and should *not* do. Agents run unattended, so
   an unscoped agent will happily wander: name the repos/folders it works in,
   the kinds of tasks it accepts, and what to do with tasks that don't fit
   (fail fast with an explanation, rather than improvising).
3. **Guardrails** — hard rules. Things like "never push to main", "never edit
   files outside `docs/`", "don't run destructive commands", "ask for a
   subtask instead of expanding scope". Remember agents run with bypassed
   permission prompts — the instructions *are* the guardrails.
4. **Output format** — what the task `result` should look like. The result is
   what humans (and the manager agent) read on the task board, so specify it:
   a summary followed by a file list, a markdown review with severity levels,
   a link list — whatever the consumer of the task needs.

Keep instructions declarative and short enough to audit at a glance. If you
find yourself writing a decision tree, that's usually a sign the agent should
be two agents.

## Example: a code reviewer (with a workspace)

Attach this agent to a workspace containing the repo(s) it reviews. Its tasks
would be things like "Review the diff between main and feature/auth in
backend/".

> **Name:** `backend-reviewer` · **Role:** specialist · **Workspace:** `core-repos`
>
> **Instructions:**
>
> You are a senior backend code reviewer for the repositories in this
> workspace (folders `backend/` and `shared-lib/`).
>
> Scope: review only. You may run read-only git commands (`git log`,
> `git diff`, `git show`), search the code, and run the test suite. Never
> modify files, never commit, never push. If a task asks you to fix
> something rather than review it, fail the task and say it belongs to an
> implementation agent.
>
> For each review, check: correctness, security (injection, authz, secrets
> in code), test coverage of changed lines, and consistency with existing
> patterns in the codebase.
>
> Output format — a markdown report:
> - **Verdict:** approve / request changes
> - **Findings:** one bullet per issue as `[blocker|major|minor]
>   file:line — description and a suggested fix`
> - **Test gaps:** what's untested, if anything
> Keep it under 500 words; skip praise.

## Example: a research assistant (no workspace)

No workspace, no repos — this agent never touches disk beyond a scratch
directory, so leave `workspace_id` empty.

> **Name:** `research-assistant` · **Role:** specialist · **Workspace:** — (none)
>
> **Instructions:**
>
> You are a technical research assistant. Given a question or topic, produce
> a concise, sourced brief.
>
> Scope: research and writing only. You have no codebase; do not attempt to
> clone repos or modify files. If a task requires touching code, fail it and
> point to a workspace-attached agent.
>
> Method: prefer primary sources (official docs, changelogs, RFCs, papers).
> Note when sources disagree or when you're inferring rather than citing.
>
> Output format:
> - **TL;DR** — 3 sentences max
> - **Findings** — bullets, each ending with its source
> - **Open questions** — what you couldn't confirm
> Never present speculation as fact.

## The agent-builder flow

You don't have to hand-write config. The web UI has an agent builder: describe
what you want in plain language ("an agent that triages incoming GitHub issues
for the api repo and labels them by severity"), and the request (`idea` +
`projectId`, validated by `agentBuilderRequestSchema` in
`@agent-fleet/shared`) is sent to Claude, which drafts the full agent config —
name, instructions following the structure above, suggested model, and any
MCP servers it thinks the job needs. You review and edit the draft in the
normal agent form before saving; nothing is created until you approve it.

## MCP servers per agent

The `mcp_servers` field is a JSON array; each entry gives the agent an extra
tool server for its runs. Shape (validated by `mcpServerSchema`):

```jsonc
{
  "name": "...",                    // unique per agent
  "type": "stdio" | "http" | "sse",
  "command": "...", "args": [...],  // stdio only
  "url": "...",                     // http / sse only
  "env": { "KEY": "value" }         // optional, stdio only
}
```

**stdio** — the worker spawns a local process inside its container and talks
MCP over stdin/stdout. The command must exist in the worker image (Node and
`npx` do; anything else needs adding to `infra/worker.Dockerfile`):

```json
{
  "name": "filesystem",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/workspaces"],
  "env": { "SOME_FLAG": "1" }
}
```

**http** (or **sse** for legacy servers) — the worker connects to a remote MCP
endpoint over the network; nothing to install:

```json
{
  "name": "github",
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/"
}
```

Anything you put in `env` (tokens, etc.) is stored in the database and passed
to the spawned process — prefer servers that can read secrets from the
worker's own environment where possible.

For full worked examples of MCP-powered agents — Slack and Gmail triage
agents with ready-to-paste configs, instructions, and voice profiles — see
[COMMS-AGENTS.md](COMMS-AGENTS.md).

## The `plugins` field (roadmap)

`plugins` is a free-form array of strings (e.g. `["code-review", "pdf"]`).
The intent is for the worker runtime to map each string to a skill/plugin
made available to the agent's SDK session. **This mapping is roadmap — today
the values are stored and displayed but not yet interpreted by the runtime.**
Feel free to tag agents anyway; the tags will light up when the runtime
support lands, and until then they serve as documentation of intent.
