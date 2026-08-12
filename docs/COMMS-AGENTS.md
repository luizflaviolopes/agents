# Communication Agents — Slack & Gmail Triage

This guide walks you through setting up two specialist agents that triage your
communications: a **Slack comms agent** and a **Gmail comms agent**. Both
follow the same pattern — they *read* your inbox, *draft* replies in your
voice, and *propose* every outbound message for your approval. Nothing is ever
sent without you clicking Approve.

## How it works

The pieces (see [ARCHITECTURE.md](../ARCHITECTURE.md), "Automations layer"):

1. **Reading** — the agent reads Slack/Gmail through an MCP server configured
   on the agent (`mcp_servers`), using read-side credentials you provide in
   the server's `env`.
2. **Drafting** — the agent writes replies in *your* voice, guided by voice
   profile docs stored in its knowledge (`agent_knowledge` rows with
   `kind = 'voice'`). Multiple voices are supported: each voice doc states who
   it applies to and when, and the agent picks the matching one per message.
3. **Proposing** — instead of sending, the agent calls the `propose_action`
   tool. That writes a `pending_actions` row with a human-readable `preview`
   and the exact `payload` to send (`action_type`:
   `slack_reply | slack_message | gmail_reply | gmail_send`).
4. **Approving** — you approve or reject each pending action in the web
   **Review** tab or via Telegram inline buttons. You can edit the text before
   approving.
5. **Sending** — the worker's **deterministic executor** (plain code, no LLM)
   sends approved actions using the per-project **Integration** credentials
   (project → Integrations). Agents never hold send credentials and never call
   a send API themselves.
6. **Scheduling** — a schedule row runs the agent every N minutes so triage
   happens continuously without you kicking it off.

One nuance worth understanding: for Slack the read-side MCP token and the
Integration send token are the *same* user token (there is only one "you" in
Slack), but they travel different paths — the MCP server only ever reads, and
the executor only ever sends. For Gmail the same OAuth client + refresh token
serves both sides. The separation is behavioral, enforced by agent
instructions plus the approval gate, and (for Slack) by the MCP server's own
posting switch, which we leave off.

---

## Slack setup

### 1. Create a Slack app with a user token (xoxp)

You'll create a minimal Slack app whose only job is to mint a **user OAuth
token** — a token that acts *as you*. Messages sent with it appear exactly as
if you typed them (your name, your avatar, no "APP" badge).

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   Name it something like `My Comms Agent`, pick your workspace.
2. In the left sidebar: **OAuth & Permissions** → scroll to **Scopes** →
   **User Token Scopes** (NOT Bot Token Scopes) → add:

   | Scope | Why |
   |---|---|
   | `channels:history` | read public channel messages |
   | `channels:read` | list public channels |
   | `groups:history` | read private channel messages |
   | `groups:read` | list private channels |
   | `im:history` | read your DMs |
   | `im:read` | list your DMs |
   | `mpim:history` | read group DMs |
   | `mpim:read` | list group DMs |
   | `users:read` | resolve user IDs to names |
   | `search:read` | search messages (mentions of you, keywords) |
   | `chat:write` | **send as you — used only by the approval executor** |

3. Scroll up on the same page → **Install to Workspace** (under "OAuth Tokens")
   → authorize.
4. Copy the **User OAuth Token** — it starts with `xoxp-`. This single token
   is used in both places below.

Alternatively, create the app **From a manifest** and paste:

```yaml
display_information:
  name: My Comms Agent
oauth_config:
  scopes:
    user:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - search:read
      - chat:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
```

### 2. MCP server on the agent (reading)

Recommended server:
[korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server)
(npm package `slack-mcp-server`). It is the most complete community Slack MCP
server: works with a plain xoxp user token, covers channels, private channels,
DMs, group DMs, threads, unreads, and search — and, critically, its
message-posting tool is **disabled by default** (env
`SLACK_MCP_ADD_MESSAGE_TOOL`, which we deliberately do not set), so the read
path physically cannot post even if the agent tried.

In the agent's config UI, add this entry to `mcp_servers`:

```json
{
  "name": "slack",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
  "env": {
    "SLACK_MCP_XOXP_TOKEN": "xoxp-your-user-oauth-token",
    "SLACK_MCP_USERS_CACHE": "/tmp/slack-mcp-users-cache.json",
    "SLACK_MCP_CHANNELS_CACHE": "/tmp/slack-mcp-channels-cache.json"
  }
}
```

Notes:

- Do **not** set `SLACK_MCP_ADD_MESSAGE_TOOL`. Leaving it unset keeps the
  `conversations_add_message` tool disabled — the MCP server is read-only.
- The two cache paths keep the server's user/channel cache files out of the
  agent's workspace directory (they default to relative paths in the cwd).
- Useful tools it exposes: `conversations_history`, `conversations_replies`
  (threads), `conversations_unreads`, `conversations_search_messages`,
  `channels_list`, `users_search`.

### 3. Integration (sending)

In the web UI: **project → Integrations → Slack** → paste the **same**
`xoxp-` token into the `userToken` field
(`slackIntegrationConfigSchema: { userToken }`). This credential is used
*only* by the worker's deterministic executor to send approved actions —
never by an agent.

Because it's a user token, approved replies appear in Slack exactly as you —
your name, your face, inside the original thread.

---

## Gmail setup

### 1. Google Cloud project + OAuth client

1. Go to <https://console.cloud.google.com>, create (or pick) a project.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → Google Auth Platform** (the OAuth consent screen —
   Google has been migrating this under the "Google Auth Platform" heading;
   older consoles show "OAuth consent screen"). Configure it:
   - **Audience/User type:** choose **Internal** if your account is on a
     Google Workspace domain (simplest — no verification, tokens don't
     expire). Otherwise choose **External** and add yourself as a test user.
   - App name, support email: anything; only you will see this screen.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   Application type **Desktop app**. Copy the **Client ID** and
   **Client secret**.

> **Important — the 7-day trap:** if your consent screen is **External** with
> publishing status **Testing**, Google expires refresh tokens after **7
> days** and your agent will silently stop working. Either use **Internal**
> (Workspace accounts), or push the publishing status to **In production**
> (you'll see an "unverified app" warning during the one-time consent — fine
> for personal use). Verify against Google's current docs if in doubt.

### 2. Obtain a refresh token (one-time)

Recommended scope: `https://www.googleapis.com/auth/gmail.modify` — it covers
reading, searching, labeling, archiving, *and* sending, but not permanent
deletion or settings changes. (`https://mail.google.com/` is the full-access
alternative; you don't need it.)

**Option A — one-time local script (Desktop client, recommended).** Desktop
OAuth clients accept loopback (`http://localhost:<port>`) redirects without
pre-registration. Save this as `get-refresh-token.mjs`, fill in your client ID
and secret, run `npm install google-auth-library` then
`node get-refresh-token.mjs`, and open the printed URL in your browser:

```js
import http from "node:http";
import { OAuth2Client } from "google-auth-library";

const CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const PORT = 53682;

const client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, `http://localhost:${PORT}`);
console.log("Open this URL in your browser:\n");
console.log(
  client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
  }),
);

http
  .createServer(async (req, res) => {
    const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
    if (!code) { res.end("No code in request."); return; }
    const { tokens } = await client.getToken(code);
    console.log("\nRefresh token:\n" + tokens.refresh_token);
    res.end("Done — you can close this tab.");
    process.exit(0);
  })
  .listen(PORT);
```

Copy the printed refresh token (starts with `1//`).

**Option B — OAuth 2.0 Playground.** Requires a **Web application** client
(not Desktop) with `https://developers.google.com/oauthplayground` added to
its Authorized redirect URIs. At
<https://developers.google.com/oauthplayground>: gear icon → *Use your own
OAuth credentials* → paste client ID/secret → in Step 1 enter the
`gmail.modify` scope URL → Authorize → in Step 2 click *Exchange
authorization code for tokens* → copy the refresh token.

### 3. MCP server on the agent (reading + labeling)

Recommended server:
[shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp)
(npm package `@shinzolabs/gmail-mcp`). Chosen because it runs **fully
headless** from the exact three values you already have —
`CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` as plain env vars — no
credential files to bake into the worker container. It exposes the full
triage toolkit: `list_messages`, `get_message`, `list_threads`, `get_thread`,
`list_labels`, `create_label`, `modify_message` /
`batch_modify_messages` (labeling + archiving via label changes), and trash.

Agent `mcp_servers` entry:

```json
{
  "name": "gmail",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@shinzolabs/gmail-mcp"],
  "env": {
    "CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "CLIENT_SECRET": "YOUR_CLIENT_SECRET",
    "REFRESH_TOKEN": "1//your-refresh-token"
  }
}
```

Notes:

- The server also has `send_message` / `delete_thread` tools. The agent's
  instructions forbid using them (see the template below), and a
  `gmail.modify` token cannot permanently delete. If you want belt *and*
  suspenders, this is the reason to prefer `gmail.modify` over full
  `https://mail.google.com/`.
- Alternative:
  [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)
  (`@gongrzhe/server-gmail-autoauth-mcp`) is popular and solid, but it
  authenticates via credential files in `~/.gmail-mcp/`, which you'd have to
  generate locally and mount into the worker container — workable, but
  clunkier for a headless deploy.

### 4. Integration (sending)

**project → Integrations → Gmail** — four fields
(`gmailIntegrationConfigSchema`):

| Field | Value |
|---|---|
| `clientId` | the OAuth client ID |
| `clientSecret` | the OAuth client secret |
| `refreshToken` | the refresh token from step 2 |
| `emailAddress` | the Gmail address you send as (e.g. `you@yourdomain.com`) |

Same credentials as the MCP env — but again, only the deterministic executor
uses these to actually send.

---

## Agent templates

Create both as **specialist** agents with **no workspace** (they never touch
a repo). Paste the instructions below, then rewrite the voice profiles — the
ones here are placeholders demonstrating the pattern.

### "Slack Comms Agent" — instructions

> You are my Slack triage assistant. You read my Slack workspace through the
> Slack MCP tools and prepare replies for my approval. You never send
> anything yourself.
>
> **Workflow, on every run:**
> 1. Collect what needs attention since the last run: unread conversations
>    (`conversations_unreads`), mentions of me
>    (`conversations_search_messages`), and my DMs / group DMs. Look back at
>    most 24 hours.
> 2. For each conversation or thread, decide: does this need a reply from me?
>    Skip: FYI-only messages, threads already answered by someone else,
>    bot noise, channels where I'm a passive member.
> 3. For each message that needs a reply, gather context first: read the full
>    thread (`conversations_replies`) and recent channel history. If the
>    question is technical and concerns one of this project's codebases, use
>    `ask_agent` to consult the relevant specialist agent and fold its answer
>    into the draft — do not guess at technical facts.
> 4. Draft the reply in MY voice. Match the correct voice profile from my
>    "Voice profiles" knowledge docs based on who the recipient is and what
>    language they wrote in. Match the thread's language.
> 5. Propose it with `propose_action`:
>    - Reply in an existing thread → `action_type: "slack_reply"`, payload
>      `{ "channel": "<channel id>", "thread_ts": "<parent message ts>",
>      "text": "<draft>" }`.
>    - New standalone message → `action_type: "slack_message"`, payload
>      `{ "channel": "<channel id>", "text": "<draft>" }`.
>    - Write a clear one-line `preview`: who it's to, in reply to what.
>
> **Hard rules:**
> - NEVER post to Slack directly. Do not use `conversations_add_message` or
>   any other posting/reaction tool, even if it appears in your tool list.
>   The ONLY way you output a message is `propose_action`.
> - Never propose replies to messages I sent myself.
> - One proposed reply per thread per run — don't spam alternatives.
> - If you are unsure whether something needs a reply, list it in your
>   summary as "needs your eyes" instead of drafting.
>
> **Output format (task result):** a markdown summary with three sections:
> **Proposed** (one bullet per proposed action: recipient, thread topic, and
> a one-line gist of the draft), **Skipped** (what you saw and why it needed
> no reply — keep each to one line), **Needs your eyes** (anything ambiguous,
> urgent, or outside your remit). If there was nothing at all, say so in one
> line.

### "Gmail Comms Agent" — instructions

> You are my email triage assistant. You read my Gmail through the Gmail MCP
> tools, keep my inbox organized, and prepare replies for my approval. You
> never send email yourself.
>
> **Workflow, on every run:**
>
> *Part 1 — organize (you do this directly, no approval needed):*
> Apply the rules in my "Inbox organization rules" knowledge doc to new inbox
> mail using the label tools (`list_labels`, `create_label`,
> `modify_message`, `batch_modify_messages`). Typical rules: newsletters →
> label `Newsletters` + archive (remove `INBOX`); invoices/receipts → label
> `Finance/Invoices`, keep in inbox; automated notifications → label + archive.
> Create a missing label rather than skipping a rule. Never delete anything;
> never touch spam settings.
>
> *Part 2 — triage and draft:*
> 1. List unreplied threads in the inbox addressed to me (not merely cc'd,
>    unless I'm asked something directly), from the last 24 hours.
> 2. For each, decide: does it need a reply from me? Skip newsletters,
>    receipts, notifications, and threads where my reply is not awaited.
> 3. Gather context: read the whole thread (`get_thread`). If the question is
>    technical and concerns one of this project's codebases, use `ask_agent`
>    to consult the relevant specialist agent — don't guess.
> 4. Draft the reply in MY voice, using the matching voice profile from my
>    "Voice profiles" knowledge docs (match recipient and language).
> 5. Propose it with `propose_action`:
>    - Reply in a thread → `action_type: "gmail_reply"`, payload
>      `{ "to": "<recipient>", "subject": "Re: <subject>", "body": "<draft>",
>      "thread_id": "<gmail thread id>",
>      "in_reply_to_message_id": "<the message id being answered>" }`
>      (add `"cc"` only if the thread already had those people on cc).
>    - Brand-new email (rare — only if a task explicitly asks) →
>      `action_type: "gmail_send"` with `to`/`subject`/`body`.
>    - `preview`: one line — who, about what.
>
> **Hard rules:**
> - NEVER send email directly. Do not use `send_message` or any draft-send
>   tool even if it appears in your tool list. The ONLY way you output an
>   email is `propose_action`.
> - Labeling and archiving are allowed freely; deleting is not — never use
>   trash/delete tools.
> - One proposed reply per thread per run.
>
> **Output format (task result):** markdown with sections **Organized**
> (counts per rule applied, e.g. "7 newsletters labeled + archived"),
> **Proposed** (one bullet per proposed reply: sender, subject, gist of
> draft), **Skipped** (one line each), **Needs your eyes**.

### Companion knowledge doc for the Gmail agent: "Inbox organization rules"

Create a knowledge doc (kind `knowledge`, title `Inbox organization rules`)
on the Gmail agent. Example content to adapt:

> - Newsletters and marketing (unsubscribe link present, bulk senders):
>   label `Newsletters`, archive.
> - Invoices, receipts, payment confirmations: label `Finance/Invoices`,
>   keep in inbox.
> - Automated notifications (GitHub, CI, monitoring, SaaS product emails):
>   label `Notifications`, archive unless it reports a failure.
> - Calendar invites and replies: leave alone.
> - Anything from `@jolifox.com` colleagues: leave in inbox, never archive.

### Voice profile docs (kind `voice`)

Create these as knowledge docs with `kind = 'voice'` on **each** comms agent
(Slack and Gmail keep separate copies — they are per-agent). The worker
groups all `voice` docs under a "Voice profiles" heading in the agent's
system prompt; because there can be several, **each doc must say in its own
content who it applies to and when**, so the agent can pick per message.

These three are *templates showing the pattern* — rewrite them so they sound
like you (or better: run the voice-training bootstrap task below and let the
agent draft them from your real sent messages).

**Doc 1 — title: `Voice — team (PT-BR, casual)`**

> **Applies to:** colleagues at Jolifox (Slack workspace members,
> `@jolifox.com` email addresses) writing in Portuguese, and internal
> channels in general.
>
> **Tone:** casual, direct, warm. First names. Contractions and light slang
> are fine ("beleza", "bora", "valeu"). No corporate filler. Emojis sparingly
> — 👍 or 😄 at most one per message. Short sentences; get to the point in
> the first line.
>
> **Structure:** answer first, context after. For a request I'm accepting:
> confirm + when I'll do it. For a request I'm declining: say no clearly,
> offer the alternative.
>
> **Example phrases:**
> - "Boa! Consigo olhar isso hoje à tarde, te aviso quando subir."
> - "Rapidinho: o deploy travou no passo do Docker, já estou vendo."
> - "Valeu por avisar 🙌 — pode mandar o link do PR?"

**Doc 2 — title: `Voice — clients (EN, professional)`**

> **Applies to:** clients and external business contacts writing in English;
> anyone outside the company discussing contracts, deliverables, or money.
>
> **Tone:** professional but human — no stiff boilerplate. Confident,
> specific, calm. Never over-apologize; acknowledge once, then move to the
> fix. No emojis. No exclamation marks except a genuine "Thanks!".
>
> **Structure:** greeting with first name → direct answer or status →
> concrete next step with a date → short sign-off ("Best, Luiz").
>
> **Example phrases:**
> - "Thanks for flagging this — you're right that the export is off. We're
>   shipping a fix by Thursday; I'll confirm here once it's live."
> - "Happy to walk you through it. Does Tuesday 14:00 (your time) work?"
> - "Quick status update before the weekend: …"

**Doc 3 — title: `Voice — vendors & support (EN, brief)`**

> **Applies to:** vendor support desks, SaaS providers, recruiters, cold
> outreach — anyone I have no relationship with, writing in English.
>
> **Tone:** brief, polite, zero warmth-padding. Two to four sentences total.
> State the issue/answer, the one thing I need, done.
>
> **Structure:** no greeting fluff ("Hi," is enough) → the ask or the answer
> → account/reference IDs when relevant → "Thanks, Luiz".
>
> **Example phrases:**
> - "Hi, invoice #4821 was paid on Aug 3 but still shows as overdue. Can you
>   check? Thanks, Luiz."
> - "Not interested at this time, but thanks for reaching out."

### Schedules

Create one schedule per agent (**project → Schedules**, backed by
`createScheduleSchema`):

**Slack — every 15 minutes:**

| Field | Value |
|---|---|
| Name | `Slack triage` |
| Agent | Slack Comms Agent |
| Interval | `15` minutes |
| Task title | `Triage Slack inbox` |
| Task description | `Triage my Slack since the last run: check unreads, mentions, and DMs; propose replies for anything that needs me; report what you proposed and skipped, per your instructions.` |

**Gmail — every 5 minutes:**

| Field | Value |
|---|---|
| Name | `Gmail triage` |
| Agent | Gmail Comms Agent |
| Interval | `5` minutes |
| Task title | `Triage Gmail inbox` |
| Task description | `Process new mail since the last run: apply my inbox organization rules (label/archive), then propose replies for threads that need me. Report organized/proposed/skipped, per your instructions.` |

Each firing inserts a normal task (`source = 'schedule'`) that the worker
claims and runs; results show up on the task board like any other run.

### Voice-training bootstrap (one-off task)

Voice profiles are far better when derived from how you *actually* write.
Run this once per comms agent as a normal one-off task (assign it to the
agent from the task board), then paste the output into the Knowledge editor.

> **Note:** agents cannot yet write their own knowledge docs via tools
> (that's on the roadmap) — which is why this task asks the agent to *output*
> the proposed docs in its result for you to paste in manually.

**Task title:** `Study my sent messages and draft my voice profiles`

**Task description (Slack agent version — adapt tool names for Gmail):**

> Read a broad sample of messages I have sent recently: for Slack, use
> `conversations_search_messages` filtered to messages from me, plus my side
> of recent DM and channel threads (aim for 100+ messages across different
> recipients); for Gmail, list and read 30–50 threads from my Sent mail.
>
> Cluster them by audience and language — e.g. teammates vs. clients vs.
> vendors, Portuguese vs. English. For each cluster, extract: typical tone,
> formality, sentence length, greeting/sign-off habits, emoji and punctuation
> habits, characteristic phrases I reuse, and anything I consistently avoid.
>
> Then draft one voice profile document per cluster, each with this exact
> structure: a title like `Voice — <audience> (<language>, <register>)`, an
> **Applies to** section (who/when, precise enough that a triage agent can
> pick the right profile from the recipient and language alone), a **Tone**
> section, a **Structure** section, and 3–5 **Example phrases** taken or
> adapted from my real messages (never include confidential content —
> replace specifics with placeholders).
>
> You cannot write knowledge docs yourself, so output the complete proposed
> docs verbatim in your task result, clearly separated, ready for me to paste
> into the Knowledge editor with kind "voice". Do not propose any messages
> in this task.

---

## Safety model

| | Allowed freely | Requires my approval | Never |
|---|---|---|---|
| **Slack agent** | read channels/DMs/threads, search, resolve users | any outbound message (`slack_reply`, `slack_message`) | posting via MCP (tool disabled server-side + forbidden by instructions) |
| **Gmail agent** | read, search, label, archive, create labels | any outbound email (`gmail_reply`, `gmail_send`) | deleting mail, sending via MCP (forbidden by instructions; `gmail.modify` scope blocks permanent deletion) |

**Where credentials live:**

- Read side: in each agent's `mcp_servers[].env` (stored in the `agents`
  table, passed to the spawned MCP process).
- Send side: in the project's `integrations` row (`config` jsonb) — used only
  by the worker's deterministic executor after you approve.
- Both are server-side only; the browser never sees them (backend authz —
  see [ARCHITECTURE.md](../ARCHITECTURE.md)).

**Why sends are trustworthy:** the executor sends exactly the approved
`payload` (or your edited version) — no LLM sits between your approval and
the API call.

**If a token leaks (or you just want to rotate):**

- **Slack:** api.slack.com/apps → your app → *OAuth & Permissions* →
  *Revoke All Tokens* (or remove the app from the workspace), reinstall to
  get a fresh `xoxp-` token, update it in **both** the agent's MCP env and
  the project Integration.
- **Gmail:** revoke the grant at
  [myaccount.google.com/connections](https://myaccount.google.com/connections)
  (and/or delete the OAuth client in Google Cloud console), mint a new
  refresh token with the script above, update the agent MCP env and the
  Integration. Rotate the client secret too if the leak included it.
- Remember both copies: rotating only the Integration leaves the old token
  live in the agent's MCP config, and vice versa.
