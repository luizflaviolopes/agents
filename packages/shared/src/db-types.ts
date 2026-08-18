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
  | "gmail_send";

export type PendingActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed";

export type KnowledgeKind = "knowledge" | "voice";

export type ScheduleKind = "interval" | "daily";

export type IntegrationType = "slack" | "gmail";

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
  /** Exact data the executor will send (Slack/Gmail action payload). */
  payload: SlackActionPayload | GmailActionPayload;
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
