import type {
  AgentRole,
  IntegrationType,
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
] as const satisfies readonly IntegrationType[];
