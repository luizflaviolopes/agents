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
