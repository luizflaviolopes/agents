# Fleet MCP Server — Configure Your Agents From Your Own Machine

Agent Fleet exposes its own **MCP server**, so the Claude Code session on your
laptop can read and change the agents of your account: list projects, read an
agent's instructions, rewire its MCP servers, tighten its tool limits, create a
specialist, retire one. Same rules as the web UI, no browser.

The endpoint is `POST /api/mcp` on your deployment, it speaks Streamable HTTP,
and it authenticates with a **personal access token** you mint in Settings.

> This is the mirror image of the rest of the docs. Everywhere else, an *agent
> of yours* reaches out to a service through MCP. Here, *your* agent reaches
> into the fleet.

## 1. Mint a token

**Settings → MCP access → Create token.** Give it the name of the machine it
will live on, optionally an expiry, and copy the value — it is shown once and
never again. What the server keeps is a SHA-256 of it, which is enough to
verify a token and not enough to reconstruct one.

A token acts as **you**, across every project on your account. There is no
per-project or read-only scope, and the UI says so rather than implying a
boundary the code does not enforce. Two things bound it instead:

- **It works only at `/api/mcp`.** No other route accepts it — they all read
  the session cookie. In particular, a token cannot mint another token, so
  revocation is not a race against a copy of itself.
- **Revoke is instant and per token.** Settings → MCP access → Revoke. Machines
  using it get a 401 on their next call.

## 2. Add the server

```bash
claude mcp add --transport http agent-fleet \
  https://your-fleet.example.com/api/mcp \
  --header "Authorization: Bearer aft_..."
```

The Settings card prints this command with your deployment's URL already filled
in (from `WEB_URL`, falling back to the address you loaded the page from).

Any MCP client works — the endpoint is a plain stateless Streamable HTTP
server. Clients that cannot set an arbitrary header may send the token as
`X-Api-Key` instead.

Verify it:

```bash
claude mcp list
```

Then, in a session:

> Show me the agents in my Ops project, and what tools the Ticket Reviewer is
> allowed to use.

## 3. What the tools do

| Tool | |
| --- | --- |
| `list_projects` | Every project on the account, with the ids the rest take. |
| `list_workspaces` | A project's workspaces and their repos — the `workspace_id` values an agent can be attached to. |
| `list_agents` | Full configuration of every agent in a project. |
| `get_agent` | One agent's full configuration. |
| `create_agent` | Add a specialist, or the project's single librarian. |
| `update_agent` | Change name, role, instructions, model, workspace, plugins, MCP servers, tool limits, active flag. |
| `delete_agent` | Delete an agent. |

Arguments are `snake_case` and match the fields that come back, so a
configuration can be read, edited and written straight back. The exception is
the inside of an `mcp_servers` entry, which is stored verbatim and keeps its
own keys (`askTools`).

Three rules of the fleet are enforced here exactly as in the UI, because both
go through the same service layer (`apps/web/src/lib/agents/service.ts`):

- the **manager** agent cannot be deleted or re-roled,
- a project has at most **one librarian**,
- a `workspace_id` must belong to the same project, owned by you.

`update_agent` touches only the fields you send — but every array field
(`plugins`, `mcp_servers`, `allowed_tools`, `disallowed_tools`) **replaces**
its stored value wholesale. To add one MCP server to an agent that has two,
send all three.

## 4. Secrets read back redacted

The values under an MCP server's `env` and `headers` are credentials — a Notion
token, a GitHub PAT. This endpoint will not disclose them: they read back as
the literal string `__redacted__`.

That is the same instinct as the [approval gate](../ARCHITECTURE.md) in
migration 0010, which exists so a write credential never enters an LLM session.
Handing the identical secret to a model over here because it asked politely
would be an odd place to stop caring.

Because array fields replace wholesale, the placeholder is also accepted **on
the way in**, where it means *keep what is stored*:

```jsonc
// Adding a server while keeping the existing one's token
{
  "agent_id": "…",
  "mcp_servers": [
    {
      "name": "notion",
      "type": "http",
      "url": "https://mcp.notion.com/mcp",
      "headers": { "Authorization": "__redacted__" }   // ← kept as stored
    },
    {
      "name": "linear",
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer lin_api_…" } // ← new, supplied in full
    }
  ]
}
```

Matching is by server `name` and key. A placeholder with no stored value behind
it is an error, not an empty string — better a refusal than the string
`__redacted__` sitting in a live config, failing at 3am somewhere less obvious.

**A new secret must therefore be supplied in full**, either through this tool
or in the web UI. There is no way to ask the endpoint what the old one was.

## 5. What is *not* here

Only agent configuration. No tasks, no chat, no run logs, no knowledge docs, no
integration credentials — those stay in the web UI and Telegram. It is a
deliberate floor on what a leaked token is worth, and the list is one array in
`apps/web/src/lib/mcp/tools.ts` when you decide it should grow.

## 6. Operating notes

- **Apply migration `0012_api_tokens.sql`** before using any of this
  (`npx supabase db push`, or paste it into the SQL editor). Without the table,
  every token fails to verify and the endpoint answers 401 — it fails closed.
- **`GET /api/mcp` answers 405.** That is the server-to-client SSE stream of
  the Streamable HTTP transport; this server is stateless and never initiates
  messages, which the spec provides for. Clients fall back to plain POST.
- **No CORS headers, by design.** A page on another origin cannot read a
  response from here even if it somehow held a token — the DNS-rebinding
  protection the transport spec asks for, obtained by not opting out of the
  same-origin policy.
- **`last_used_at`** is refreshed at most every five minutes, so a busy session
  does not write a row per tool call. It answers "is this token still in use",
  not "when exactly".
- **Failures come back as tool errors**, not JSON-RPC errors: a model that gets
  `Project not found` in the result can correct itself; one that gets a
  transport error cannot.
