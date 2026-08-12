/**
 * Hand-written Row types mirroring the Postgres schema in
 * supabase/migrations/. Keep the two in sync.
 */

// ---------------------------------------------------------------------------
// Enum-ish string-literal unions (mirror the CHECK constraints)
// ---------------------------------------------------------------------------

export type CloneStatus = "pending" | "cloning" | "ready" | "error";

export type AgentRole = "manager" | "specialist";

export type TaskSource =
  | "web"
  | "telegram"
  | "manager"
  | "system"
  | "schedule"
  | "agent";

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

export type MessageSender = "user" | "manager";

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
  env?: Record<string, string>;
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
  is_active: boolean;
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
  interval_minutes: number;
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
  agent_id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
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
  sender: MessageSender;
  channel: MessageChannel;
  content: string;
  created_at: string;
}
