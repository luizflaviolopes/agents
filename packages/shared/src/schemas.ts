import { z } from "zod";
import {
  DEFAULT_MODEL,
  INTEGRATION_TYPES,
  MCP_APPROVAL_POLICIES,
} from "./constants";

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
  /** stdio only — environment of the spawned process. */
  env: z.record(z.string()).optional(),
  /** http/sse only — request headers (e.g. an Authorization bearer token). */
  headers: z.record(z.string()).optional(),
  /** Approval policy for this server's tools (0010). Omitted = 'never'. */
  approval: z.enum(MCP_APPROVAL_POLICIES).optional(),
  /**
   * Tools requiring approval when approval is 'ask'. Omitted/empty gates
   * every tool on the server — see McpServerConfig.askTools.
   */
  askTools: z.array(z.string().min(1).max(200)).max(200).optional(),
  /**
   * Project integration holding the write credential the executor should use
   * for approved calls, instead of the env/headers above (0010).
   */
  integration: z.enum(INTEGRATION_TYPES).optional(),
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
  /** Built-in SDK tool limits (0009); empty arrays = unrestricted. */
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
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
  /**
   * Target chat thread (0005): omitted/undefined = the project's manager
   * thread; a uuid = the direct thread with that agent.
   */
  agentId: z.string().uuid().optional(),
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

/**
 * Ensures the timing field matching `kind` is present. Applied to both
 * create (kind always present) and update (only when kind is present)
 * payloads.
 */
const scheduleKindRefinement = (
  val: {
    kind?: "interval" | "daily";
    intervalMinutes?: number;
    runAtTime?: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (val.kind === "interval" && val.intervalMinutes === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["intervalMinutes"],
      message: "intervalMinutes is required when kind is 'interval'",
    });
  }
  if (val.kind === "daily" && val.runAtTime === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAtTime"],
      message: "runAtTime is required when kind is 'daily'",
    });
  }
};

const scheduleBaseSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
  name: z.string().min(1).max(120),
  kind: z.enum(["interval", "daily"]),
  /** Required when kind = 'interval'. */
  intervalMinutes: z.number().int().min(1).optional(),
  /** Required when kind = 'daily'. 24h "HH:MM" wall-clock time. */
  runAtTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "runAtTime must be 'HH:MM'")
    .optional(),
  /** Allowed weekdays for 'daily' schedules: 0 = Sunday .. 6 = Saturday. */
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .default([0, 1, 2, 3, 4, 5, 6]),
  /** IANA timezone name (UI sends the browser timezone). */
  timezone: z.string().min(1).default("UTC"),
  taskTitle: z.string().min(1).max(300),
  taskDescription: z.string().max(10000).optional(),
  enabled: z.boolean().default(true),
});

export const createScheduleSchema =
  scheduleBaseSchema.superRefine(scheduleKindRefinement);
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = scheduleBaseSchema
  .omit({ projectId: true })
  .partial()
  .superRefine(scheduleKindRefinement);
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

const knowledgeBaseSchema = z.object({
  /** 'agent' requires agentId; 'project' requires projectId. */
  scope: z.enum(["agent", "project"]),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  kind: z.enum(["knowledge", "voice"]).default("knowledge"),
  title: z.string().min(1).max(300),
  content: z.string().max(100000).default(""),
});

export const createKnowledgeSchema = knowledgeBaseSchema.superRefine(
  (val, ctx) => {
    if (val.scope === "agent" && val.agentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentId"],
        message: "agentId is required when scope is 'agent'",
      });
    }
    if (val.scope === "project" && val.projectId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectId"],
        message: "projectId is required when scope is 'project'",
      });
    }
    if (val.kind === "voice" && val.scope !== "agent") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "kind 'voice' is only valid for scope 'agent'",
      });
    }
  },
);
export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;

export const updateKnowledgeSchema = knowledgeBaseSchema
  .omit({ scope: true, agentId: true, projectId: true })
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

/**
 * Config for an integration that holds a write credential for an MCP server
 * (github/notion — see MCP_INTEGRATION_TYPES). The credential is applied to
 * the executor's OWN connection to the server, which is why it has to say
 * where the token goes: a remote server takes it in a header, a stdio server
 * in an environment variable.
 */
export const mcpIntegrationConfigSchema = z
  .object({
    writeToken: z.string().min(1),
    /**
     * http/sse: header carrying the token. Defaults to an
     * `Authorization: Bearer <writeToken>` header, which is what GitHub's and
     * Notion's hosted MCP endpoints expect.
     */
    headerName: z.string().min(1).max(120).optional(),
    /** stdio: environment variable carrying the token, e.g. NOTION_TOKEN. */
    envVar: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "envVar must be a valid variable name")
      .optional(),
    /**
     * http/sse: endpoint the executor should call instead of the agent's own
     * `url`. Needed whenever read-only is a property of the ENDPOINT rather
     * than of the token — GitHub's hosted MCP server is the case in point,
     * where `/mcp/readonly` refuses writes no matter which PAT is presented.
     * Without this, pointing an agent at the read-only URL (the right thing to
     * do) would make every approved write fail against it.
     */
    url: z.string().url().optional(),
  })
  .strict();
export type McpIntegrationConfig = z.infer<typeof mcpIntegrationConfigSchema>;

export const upsertIntegrationSchema = z.object({
  type: z.enum(INTEGRATION_TYPES),
  /** Validated against the per-type config schema in the route handler. */
  config: z.record(z.unknown()),
});
export type UpsertIntegrationInput = z.infer<typeof upsertIntegrationSchema>;
