import "server-only";
import { z } from "zod";
import type { Agent, McpServerConfig } from "@agent-fleet/shared";
import { AGENT_AUTH_MODES, mcpServerSchema } from "@agent-fleet/shared";
import { ApiResponseError, requireProjectAccess } from "@/lib/api/auth";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "@/lib/agents/service";
import { getAdminClient } from "@/lib/supabase/admin";
import type { McpTool } from "@/lib/mcp/protocol";

/**
 * The fleet's own MCP tools: agent configuration, reachable from an MCP
 * client on the owner's machine.
 *
 * Argument names are snake_case, matching the rows these tools hand back, so
 * a model can read a configuration and write it straight back without
 * translating. The one exception is the inside of an `mcp_servers` entry,
 * which is stored verbatim as jsonb and keeps the camelCase keys the worker
 * reads (`askTools`).
 */

export interface McpToolContext {
  /** Owner the calling token authenticates as. Every query is scoped to it. */
  userId: string;
}

/**
 * Stand-in for a secret this endpoint will not disclose. The values under an
 * MCP server's `env` and `headers` are credentials — a Notion token, a GitHub
 * PAT — and reading them out on request would undo the point of keeping write
 * credentials in project integrations where no agent session can reach them
 * (migration 0010).
 *
 * It is also accepted on the way IN, where it means "keep what is stored".
 * Without that, editing an agent's server list — always a whole-array write —
 * would force the caller to re-supply the secrets it was just refused, and
 * the only way to comply would be to go and find the real ones.
 */
export const REDACTED = "__redacted__";

function redactValues(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED]));
}

function redactServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    ...(server.env ? { env: redactValues(server.env) } : {}),
    ...(server.headers ? { headers: redactValues(server.headers) } : {}),
  };
}

/** An agent as these tools return it: the stored row, minus its secrets. */
function serializeAgent(agent: Agent) {
  return {
    ...agent,
    mcp_servers: (agent.mcp_servers ?? []).map(redactServer),
  };
}

/**
 * Put the stored secrets back wherever the caller sent REDACTED, matching
 * servers by name. A placeholder with nothing behind it is an error rather
 * than an empty string: writing the placeholder into a live config as if it
 * were a credential would fail later, somewhere far less obvious.
 */
function restoreSecrets(
  next: McpServerConfig[],
  previous: McpServerConfig[],
): McpServerConfig[] {
  return next.map((server) => {
    const stored = previous.find((candidate) => candidate.name === server.name);

    const restore = (
      values: Record<string, string>,
      storedValues: Record<string, string> | undefined,
      field: string,
    ): Record<string, string> =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          if (value !== REDACTED) return [key, value];
          const kept = storedValues?.[key];
          if (kept === undefined) {
            throw new ApiResponseError(
              400,
              `No stored secret to keep for ${field}.${key} on MCP server ` +
                `"${server.name}". Send the real value, or set it in the web UI.`,
            );
          }
          return [key, kept];
        }),
      );

    return {
      ...server,
      ...(server.env ? { env: restore(server.env, stored?.env, "env") } : {}),
      ...(server.headers
        ? { headers: restore(server.headers, stored?.headers, "headers") }
        : {}),
    };
  });
}

/** Validate a tool's arguments, reporting the first problem plainly. */
function parseArgs<S extends z.ZodTypeAny>(
  schema: S,
  args: Record<string, unknown>,
): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.errors[0];
  const path = issue?.path.join(".");
  const message = issue?.message ?? "Invalid arguments";
  throw new ApiResponseError(400, path ? `${path}: ${message}` : message);
}

// ---------------------------------------------------------------------------
// Argument schemas. Each is paired with the JSON Schema advertised in
// tools/list further down — change one, change the other.
// ---------------------------------------------------------------------------

const projectIdArgs = z.object({ project_id: z.string().uuid() });
const agentIdArgs = z.object({ agent_id: z.string().uuid() });

const agentConfigShape = {
  name: z.string().min(1).max(120),
  role: z.enum(["specialist", "librarian"]),
  instructions: z.string(),
  model: z.string().min(1),
  workspace_id: z.string().uuid().nullable(),
  plugins: z.array(z.string()),
  mcp_servers: z.array(mcpServerSchema),
  allowed_tools: z.array(z.string()),
  disallowed_tools: z.array(z.string()),
  auth_mode: z.enum(AGENT_AUTH_MODES),
};

const createAgentArgs = z
  .object({ project_id: z.string().uuid(), ...agentConfigShape })
  .partial()
  .required({ project_id: true, name: true });

const updateAgentArgs = z
  .object({
    agent_id: z.string().uuid(),
    ...agentConfigShape,
    is_active: z.boolean(),
  })
  .partial()
  .required({ agent_id: true });

// ---------------------------------------------------------------------------
// JSON Schema fragments for tools/list
// ---------------------------------------------------------------------------

const uuidSchema = { type: "string", format: "uuid" } as const;

const SECRET_NOTE =
  'Values read back as "__redacted__"; send that back to keep the stored secret.';

const mcpServerJsonSchema = {
  type: "object",
  required: ["name", "type"],
  properties: {
    name: { type: "string", description: "Identifier used in tool prefixes." },
    type: { type: "string", enum: ["stdio", "http", "sse"] },
    command: { type: "string", description: "stdio only: executable to run." },
    args: { type: "array", items: { type: "string" } },
    url: { type: "string", description: "http/sse only: endpoint URL." },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: `stdio only. ${SECRET_NOTE}`,
    },
    headers: {
      type: "object",
      additionalProperties: { type: "string" },
      description: `http/sse only. ${SECRET_NOTE}`,
    },
    approval: {
      type: "string",
      enum: ["never", "ask"],
      description:
        "'ask' routes this server's tool calls through owner approval instead of running them in-session.",
    },
    askTools: {
      type: "array",
      items: { type: "string" },
      description:
        "Tools to gate when approval is 'ask'. Empty or absent gates every tool on the server.",
    },
    integration: {
      type: "string",
      enum: ["slack", "gmail", "github", "notion"],
      description:
        "Project integration holding the write credential used for approved calls.",
    },
  },
} as const;

const agentConfigJsonSchema = {
  name: { type: "string", description: "Display name." },
  role: {
    type: "string",
    enum: ["specialist", "librarian"],
    description:
      "A project has at most one librarian. The manager's role is fixed.",
  },
  instructions: {
    type: "string",
    description:
      "System prompt. This is where most of an agent's behaviour lives.",
  },
  model: {
    type: "string",
    description:
      "Model id: claude-sonnet-5, claude-opus-5, claude-haiku-4-5-20251001.",
  },
  workspace_id: {
    type: ["string", "null"],
    description:
      "Workspace whose checkout the agent runs in, or null for no workspace.",
  },
  plugins: { type: "array", items: { type: "string" } },
  mcp_servers: { type: "array", items: mcpServerJsonSchema },
  allowed_tools: {
    type: "array",
    items: { type: "string" },
    description:
      "Built-in tool allow-list (Bash, Write, Edit, WebFetch...). Empty = unrestricted.",
  },
  disallowed_tools: {
    type: "array",
    items: { type: "string" },
    description: "Built-in tool deny-list, applied on top of allowed_tools.",
  },
  auth_mode: {
    type: "string",
    enum: [...AGENT_AUTH_MODES],
    description:
      "Which credential this agent's runs authenticate with. 'api' bills the " +
      "Anthropic API per token. 'subscription' runs on the worker machine's own " +
      "Claude Code login instead, drawing on its quota — cheaper for bulk work, " +
      "but the quota is shared with every other subscription agent and stalls them " +
      "all when it runs out, and such runs record no cost_usd.",
  },
} as const;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const FLEET_TOOLS: McpTool<McpToolContext>[] = [
  {
    name: "list_projects",
    title: "List projects",
    description:
      "Every project on this account, with the ids the other tools take.",
    readOnly: true,
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, { userId }) => {
      const admin = getAdminClient();
      const { data, error } = await admin
        .from("projects")
        .select("id, name, description, created_at")
        .eq("owner_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw new ApiResponseError(500, error.message);
      return { projects: data ?? [] };
    },
  },
  {
    name: "list_workspaces",
    title: "List workspaces",
    description:
      "A project's workspaces and their repos — the workspace_id values an agent can be attached to.",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: { project_id: uuidSchema },
    },
    handler: async (args, { userId }) => {
      const { project_id: projectId } = parseArgs(projectIdArgs, args);
      await requireProjectAccess(userId, projectId);
      const admin = getAdminClient();
      const { data, error } = await admin
        .from("workspaces")
        .select(
          "id, name, path, created_at, workspace_repos(folder_name, repo_url, branch, clone_status)",
        )
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
      if (error) throw new ApiResponseError(500, error.message);
      return { workspaces: data ?? [] };
    },
  },
  {
    name: "list_agents",
    title: "List agents",
    description:
      "Full configuration of every agent in a project. MCP server secrets read back redacted.",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: { project_id: uuidSchema },
    },
    handler: async (args, { userId }) => {
      const { project_id: projectId } = parseArgs(projectIdArgs, args);
      const agents = await listAgents(userId, projectId);
      return { agents: agents.map(serializeAgent) };
    },
  },
  {
    name: "get_agent",
    title: "Get agent",
    description:
      "One agent's full configuration. MCP server secrets read back redacted.",
    readOnly: true,
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: { agent_id: uuidSchema },
    },
    handler: async (args, { userId }) => {
      const { agent_id: agentId } = parseArgs(agentIdArgs, args);
      return { agent: serializeAgent(await getAgent(userId, agentId)) };
    },
  },
  {
    name: "create_agent",
    title: "Create agent",
    description:
      "Add a specialist (or the project's single librarian) to a project. Only " +
      "project_id and name are required; the rest takes the same defaults as the web UI.",
    inputSchema: {
      type: "object",
      required: ["project_id", "name"],
      properties: { project_id: uuidSchema, ...agentConfigJsonSchema },
    },
    handler: async (args, { userId }) => {
      const input = parseArgs(createAgentArgs, args);
      const agent = await createAgent(userId, input.project_id, {
        name: input.name,
        role: input.role ?? "specialist",
        instructions: input.instructions,
        model: input.model,
        workspaceId: input.workspace_id,
        plugins: input.plugins,
        // Nothing is stored yet, so a placeholder here would be preserving a
        // secret that does not exist; restoreSecrets says so plainly rather
        // than writing the placeholder itself into the config.
        mcpServers: input.mcp_servers
          ? restoreSecrets(input.mcp_servers, [])
          : undefined,
        allowedTools: input.allowed_tools,
        disallowedTools: input.disallowed_tools,
        authMode: input.auth_mode,
      });
      return { agent: serializeAgent(agent) };
    },
  },
  {
    name: "update_agent",
    title: "Update agent",
    description:
      "Change an agent's configuration. Only the fields you send are touched, but " +
      "arrays (plugins, mcp_servers, allowed_tools, disallowed_tools) replace their " +
      'stored value wholesale. Leave a secret as "__redacted__" to keep the stored one.',
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: {
        agent_id: uuidSchema,
        ...agentConfigJsonSchema,
        is_active: {
          type: "boolean",
          description: "Inactive agents stay configured but take no tasks.",
        },
      },
    },
    handler: async (args, { userId }) => {
      const input = parseArgs(updateAgentArgs, args);
      // Only a server list needs the stored one to merge placeholders
      // against; every other field is a straight write, and updateAgent
      // re-reads the agent for its own ownership check anyway.
      const mcpServers = input.mcp_servers
        ? restoreSecrets(
            input.mcp_servers,
            (await getAgent(userId, input.agent_id)).mcp_servers ?? [],
          )
        : undefined;
      const agent = await updateAgent(userId, input.agent_id, {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        model: input.model,
        workspaceId: input.workspace_id,
        plugins: input.plugins,
        mcpServers,
        allowedTools: input.allowed_tools,
        disallowedTools: input.disallowed_tools,
        authMode: input.auth_mode,
        isActive: input.is_active,
      });
      return { agent: serializeAgent(agent) };
    },
  },
  {
    name: "delete_agent",
    title: "Delete agent",
    description:
      "Permanently delete an agent. The project's manager cannot be deleted. To " +
      "stop an agent without losing its configuration, set is_active false instead.",
    destructive: true,
    inputSchema: {
      type: "object",
      required: ["agent_id"],
      properties: { agent_id: uuidSchema },
    },
    handler: async (args, { userId }) => {
      const { agent_id: agentId } = parseArgs(agentIdArgs, args);
      await deleteAgent(userId, agentId);
      return { ok: true, deleted_agent_id: agentId };
    },
  },
];

/** Guidance handed to the client once `initialize` succeeds. */
export const FLEET_INSTRUCTIONS = [
  "Agent Fleet — configure the agents of this account.",
  "",
  "Start from list_projects to get a project_id, then list_agents to see what is",
  "configured. An agent's behaviour lives almost entirely in its `instructions`;",
  "read the current value before rewriting it.",
  "",
  'Secrets inside mcp_servers (env and headers values) read back as "__redacted__".',
  "Send that value back unchanged to keep the stored secret; a new secret must be",
  "supplied in full here or set in the web UI.",
  "",
  "Every project keeps a manager agent: it cannot be deleted or re-roled, and each",
  "project has at most one librarian.",
].join("\n");
