import type {
  AgentAuthMode,
  AgentRole,
  IntegrationType,
  McpApprovalPolicy,
  KnowledgeKind,
  PendingActionStatus,
  PendingActionType,
  ScheduleKind,
  TaskStatus,
} from "./db-types";

/** Default Claude model for new agents. */
export const DEFAULT_MODEL = "claude-sonnet-5";

/** All task statuses, in lifecycle order. */
export const TASK_STATUSES = [
  "queued",
  "in_progress",
  "review",
  "done",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

/** All agent roles. */
export const AGENT_ROLES = [
  "manager",
  "specialist",
  "librarian",
] as const satisfies readonly AgentRole[];

/** All agent auth modes (0013). */
export const AGENT_AUTH_MODES = [
  "api",
  "subscription",
] as const satisfies readonly AgentAuthMode[];

/**
 * Auth mode for new agents. 'api' matches the pre-0013 behaviour and the
 * column default, so an agent created before the worker box has a Claude Code
 * login still runs.
 */
export const DEFAULT_AGENT_AUTH_MODE: AgentAuthMode = "api";

/** All schedule kinds. */
export const SCHEDULE_KINDS = [
  "interval",
  "daily",
] as const satisfies readonly ScheduleKind[];

/** Weekday labels indexed by schedules.weekdays values (0 = Sunday). */
export const WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** All pending-action types (outbound actions an agent can propose). */
export const PENDING_ACTION_TYPES = [
  "slack_reply",
  "slack_message",
  "gmail_reply",
  "gmail_send",
  "mcp_tool_call",
] as const satisfies readonly PendingActionType[];

/**
 * Types an agent may propose through `propose_action`. 'mcp_tool_call' is
 * excluded on purpose: it has its own tool ('propose_tool_call') which
 * resolves the server and tool against the agent's own configuration, so
 * there is nothing for the agent to hand-assemble here.
 */
export const PROPOSABLE_ACTION_TYPES = [
  "slack_reply",
  "slack_message",
  "gmail_reply",
  "gmail_send",
] as const satisfies readonly PendingActionType[];

/** All pending-action statuses, in lifecycle order. */
export const PENDING_ACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const satisfies readonly PendingActionStatus[];

/** All agent-knowledge kinds. */
export const KNOWLEDGE_KINDS = [
  "knowledge",
  "voice",
] as const satisfies readonly KnowledgeKind[];

/** All integration types. */
export const INTEGRATION_TYPES = [
  "slack",
  "gmail",
  "github",
  "notion",
] as const satisfies readonly IntegrationType[];

/**
 * Integrations that hold a write credential for an MCP server rather than
 * their own bespoke transport (0010). Slack and Gmail have hand-written
 * senders in the action executor; these are reached generically over MCP, so
 * they share one config shape and one executor path.
 */
export const MCP_INTEGRATION_TYPES = [
  "github",
  "notion",
] as const satisfies readonly IntegrationType[];

/** All MCP approval policies. */
export const MCP_APPROVAL_POLICIES = [
  "never",
  "ask",
] as const satisfies readonly McpApprovalPolicy[];

/**
 * Prefix on every personal access token (0012). Purely cosmetic to us — the
 * lookup is by hash — but it makes a leaked token identifiable at a glance,
 * which is what secret scanners key off.
 */
export const API_TOKEN_PREFIX = "aft_";
