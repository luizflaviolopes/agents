import { z } from "zod";
import { DEFAULT_MODEL } from "./constants";

// ---------------------------------------------------------------------------
// API payload schemas (camelCase — API layer maps to snake_case DB columns)
// ---------------------------------------------------------------------------

export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const createWorkspaceSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const addWorkspaceRepoSchema = z.object({
  workspaceId: z.string().uuid(),
  repoUrl: z.string().url(),
  branch: z.string().min(1).max(255),
  folderName: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "folderName may only contain letters, digits, dots, dashes and underscores",
    ),
});
export type AddWorkspaceRepoInput = z.infer<typeof addWorkspaceRepoSchema>;

export const mcpServerSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string()).optional(),
});
export type McpServerInput = z.infer<typeof mcpServerSchema>;

export const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  projectId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable().optional(),
  instructions: z.string().default(""),
  model: z.string().min(1).default(DEFAULT_MODEL),
  plugins: z.array(z.string()).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  priority: z.number().int().default(0),
  parentTaskId: z.string().uuid().nullable().optional(),
  source: z.enum(["web", "telegram", "manager", "system"]).default("web"),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const sendMessageSchema = z.object({
  projectId: z.string().uuid(),
  content: z.string().min(1).max(10000),
  channel: z.enum(["web", "telegram"]).default("web"),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const agentBuilderRequestSchema = z.object({
  idea: z.string().min(1).max(5000),
  projectId: z.string().uuid(),
});
export type AgentBuilderRequestInput = z.infer<typeof agentBuilderRequestSchema>;

// ---------------------------------------------------------------------------
// Automations (migration 0003): schedules, pending actions, knowledge,
// integrations
// ---------------------------------------------------------------------------

export const createScheduleSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string().min(1).max(120),
  intervalMinutes: z.number().int().min(1),
  taskTitle: z.string().min(1).max(300),
  taskDescription: z.string().max(10000).optional(),
  enabled: z.boolean().default(true),
});
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = createScheduleSchema
  .omit({ projectId: true })
  .partial();
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export const decidePendingActionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  /**
   * Optional edited payload — lets the user tweak (e.g. the text) before
   * approving. The executor sends exactly this if present.
   */
  payload: z.record(z.unknown()).optional(),
});
export type DecidePendingActionInput = z.infer<typeof decidePendingActionSchema>;

export const createKnowledgeSchema = z.object({
  agentId: z.string().uuid(),
  kind: z.enum(["knowledge", "voice"]).default("knowledge"),
  title: z.string().min(1).max(300),
  content: z.string().max(100000).default(""),
});
export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;

export const updateKnowledgeSchema = createKnowledgeSchema
  .omit({ agentId: true })
  .partial();
export type UpdateKnowledgeInput = z.infer<typeof updateKnowledgeSchema>;

export const slackIntegrationConfigSchema = z.object({
  userToken: z.string().min(1),
});
export type SlackIntegrationConfig = z.infer<typeof slackIntegrationConfigSchema>;

export const gmailIntegrationConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  emailAddress: z.string().email(),
});
export type GmailIntegrationConfig = z.infer<typeof gmailIntegrationConfigSchema>;

export const upsertIntegrationSchema = z.object({
  type: z.enum(["slack", "gmail"]),
  /** Validated against the per-type config schema in the route handler. */
  config: z.record(z.unknown()),
});
export type UpsertIntegrationInput = z.infer<typeof upsertIntegrationSchema>;
