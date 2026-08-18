/**
 * Hand-written Row types mirroring the Postgres schema in
 * supabase/migrations/. Keep the two in sync.
 */

// ---------------------------------------------------------------------------
// Enum-ish string-literal unions (mirror the CHECK constraints)
// ---------------------------------------------------------------------------

export type CloneStatus = "pending" | "cloning" | "ready" | "error";

export type AgentRole = "manager" | "specialist" | "librarian";

export type TaskSource =
  | "web"
  | "telegram"
  | "manager"
  | "system"
  | "schedule"
  | "agent"
  /** Knowledge sweep enqueued by the worker's post-run trigger (0006). */
  | "trigger"
  /** Child task created by an agent's spawn_tasks tool — async, unlike 'agent' (0008). */
  | "fanout"
  /** Aggregation task enqueued once the last 'fanout' sibling finished (0008). */
  | "fanin";

export type TaskStatus =
  | "queued"
  | "in_progress"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type RunStatus = "running" | "succeeded" | "failed";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RunLogEventType =
  | "system"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "status"
  | "error";

export type MessageSender = "user" | "manager" | "agent";

export type MessageChannel = "web" | "telegram";

export type McpServerType = "stdio" | "http" | "sse";

export type PendingActionType =
  | "slack_reply"
  | "slack_message"
  | "gmail_reply"
  | "gmail_send"
  /**
   * One approval-gated call to one tool on one of the agent's MCP servers
   * (0010). Deliberately generic: the payload names the server, the tool and
   * the frozen arguments, and the executor forwards them over its own MCP
   * client without knowing what the tool does — so gating a new server costs
   * no new action type, no payload schema and no executor branch.
   */
  | "mcp_tool_call";

export type PendingActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed";

export type KnowledgeKind = "knowledge" | "voice";

export type ScheduleKind = "interval" | "daily";

export type IntegrationType = "slack" | "gmail" | "github" | "notion";

/**
 * Approval policy for one MCP server (0010).
 *
 * - 'never' — the agent's tool calls run inline, in-session. The default, and
 *   the behaviour of every server configured before 0010.
 * - 'ask' — gated tool calls are denied inline by a PreToolUse hook and must
 *   be routed through the fleet 'propose_tool_call' tool, which queues a
 *   pending_action for the owner; the worker's deterministic executor makes
 *   the call after approval.
 */
export type McpApprovalPolicy = "never" | "ask";

// ---------------------------------------------------------------------------
// JSONB payload shapes
// ---------------------------------------------------------------------------

/** Shape of each entry in agents.mcp_servers (jsonb array). */
export interface McpServerConfig {
  name: string;
  type: McpServerType;
  /** For type 'stdio' */
  command?: string;
  /** For type 'stdio' */
  args?: string[];
  /** For type 'http' | 'sse' */
  url?: string;
  /** For type 'stdio': environment of the spawned MCP process. */
  env?: Record<string, string>;
  /**
   * For type 'http' | 'sse': request headers sent to the remote endpoint —
   * this is how authenticated remote servers are reached, e.g.
   * `{ "Authorization": "Bearer <token>" }`.
   */
  headers?: Record<string, string>;
  /**
   * Approval policy for this server's tools (0010). Absent = 'never', so
   * servers configured before 0010 keep their current behaviour.
   */
  approval?: McpApprovalPolicy;
  /**
   * Tool names that require approval when `approval` is 'ask'.
   *
   * EMPTY OR ABSENT GATES EVERY TOOL ON THE SERVER — the safe reading,
   * because the dangerous direction is allowing by omission. Listing names
   * narrows the gate to those tools, which makes it a snapshot: a tool the
   * server gains later is NOT gated until someone adds it here. An empty list
   * is the setting that stays correct without maintenance.
   */
  askTools?: string[];
  /**
   * When set, the executor authenticates its own call with the credential in
   * the project integration of this type instead of the `env`/`headers`
   * above (0010).
   *
   * This is what the gate is for: give the agent a read-only credential here
   * and keep the write credential in the integration, where only
   * deterministic code can reach it. Without it the owner is still asked to
   * approve, but the write token also sits in the agent's session — one
   * prompt injection away from being used unasked.
   */
  integration?: IntegrationType;
}

/** Payload for pending_actions of type 'slack_reply' | 'slack_message'. */
export interface SlackActionPayload {
  channel: string;
  /** Set when replying in a thread ('slack_reply'). */
  thread_ts?: string;
  text: string;
}

/** Payload for pending_actions of type 'gmail_reply' | 'gmail_send'. */
export interface GmailActionPayload {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Set when replying to an existing thread ('gmail_reply'). */
  thread_id?: string;
  in_reply_to_message_id?: string;
}

/** Payload for pending_actions of type 'mcp_tool_call' (0010). */
export interface McpToolCallActionPayload {
  /** `name` of the entry in the proposing agent's mcp_servers. */
  server: string;
  /** Bare MCP tool name, without the SDK's `mcp__<server>__` prefix. */
  tool: string;
  /**
   * Arguments exactly as the executor will send them. Frozen at proposal time
   * and never edited on approval — approving means approving this call, so
   * what was reviewed has to be what is sent. The target MCP server validates
   * them against its own input schema, which is why no per-tool schema lives
   * here.
   */
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface Profile {
  id: string; // uuid, references auth.users
  display_name: string | null;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  created_at: string; // timestamptz
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Workspace {
  id: string;
  project_id: string;
  name: string;
  /** Slugified folder name on the worker's disk under WORKSPACES_ROOT. */
  path: string;
  created_at: string;
}

export interface WorkspaceRepo {
  id: string;
  workspace_id: string;
  repo_url: string;
  branch: string;
  folder_name: string;
  clone_status: CloneStatus;
  error: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  workspace_id: string | null;
  name: string;
  role: AgentRole;
  instructions: string;
  model: string;
  /** jsonb array of plugin names. */
  plugins: string[];
  /** jsonb array of MCP server configs. */
  mcp_servers: McpServerConfig[];
  /**
   * Built-in tool allow-list (0009) — the SDK's `tools` option. Empty = no
   * allow-list at all, i.e. every built-in stays available unless disallowed.
   * A capability gate, not an instruction; see
   * supabase/migrations/0009_agent_tool_limits.sql.
   */
  allowed_tools: string[];
  /** Built-in tool deny-list (0009) — the SDK's `disallowedTools` option. */
  disallowed_tools: string[];
  is_active: boolean;
  /**
   * High-water mark for the librarian's read_project_activity sweeps (0005);
   * the worker advances it after a successful librarian run. Null for
   * non-librarian agents and before the first sweep.
   */
  activity_cursor: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  agent_id: string | null;
  created_by: string | null;
  source: TaskSource;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  parent_task_id: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskRun {
  id: string;
  task_id: string;
  agent_id: string | null;
  status: RunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /**
   * Usage/cost columns (0004) — populated by the worker from the Agent SDK
   * result message; all null when the run crashed before a result arrived.
   */
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
}

export interface RunLog {
  id: string;
  run_id: string;
  seq: number; // bigint identity
  level: LogLevel;
  event_type: RunLogEventType;
  content: Record<string, unknown>; // jsonb
  created_at: string;
}

export interface ScheduleRow {
  id: string;
  project_id: string;
  agent_id: string;
  name: string;
  kind: ScheduleKind;
  /** Required (non-null) when kind = 'interval'. */
  interval_minutes: number | null;
  /** Required (non-null) when kind = 'daily'. Postgres `time`, e.g. "09:30:00". */
  run_at_time: string | null;
  /** Allowed weekdays for 'daily' schedules: 0 = Sunday .. 6 = Saturday. */
  weekdays: number[];
  /** IANA timezone name (UI sends the browser timezone). */
  timezone: string;
  task_title: string;
  task_description: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
}

export interface PendingActionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  agent_id: string | null;
  action_type: PendingActionType;
  /** Human-readable summary shown for approval. */
  preview: string;
  /** Exact data the executor will send, per action_type. */
  payload: SlackActionPayload | GmailActionPayload | McpToolCallActionPayload;
  status: PendingActionStatus;
  error: string | null;
  decided_at: string | null;
  executed_at: string | null;
  created_at: string;
}

export interface AgentKnowledgeRow {
  id: string;
  /** Exactly one of agent_id / project_id is non-null (scope of the doc). */
  agent_id: string | null;
  /** Set for project-scoped docs, injected into every agent of the project. */
  project_id: string | null;
  kind: KnowledgeKind;
  title: string;
  content: string;
  /**
   * Provenance (0005): which agent wrote/updated the doc from which run.
   * All null = human-authored via the UI; human edits null out
   * updated_by_agent_id.
   */
  created_by_agent_id: string | null;
  updated_by_agent_id: string | null;
  source_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationRow {
  id: string;
  project_id: string;
  type: IntegrationType;
  /** jsonb credentials/config — only the worker's executor reads this. */
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  project_id: string;
  task_id: string | null;
  /**
   * Chat thread (0005): null = the project's manager thread (existing
   * behavior); non-null = a direct thread with that agent.
   */
  agent_id: string | null;
  sender: MessageSender;
  channel: MessageChannel;
  content: string;
  created_at: string;
}
