import type { AgentRole, TaskStatus } from "./db-types";

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
] as const satisfies readonly AgentRole[];
