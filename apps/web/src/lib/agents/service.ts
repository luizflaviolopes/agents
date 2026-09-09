import "server-only";
import type { Agent, AgentRole, McpServerConfig } from "@agent-fleet/shared";
import {
  ApiResponseError,
  requireAgentAccess,
  requireProjectAccess,
  requireWorkspaceAccess,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Agent CRUD, minus the transport.
 *
 * The rules enforced here — the manager is neither created, re-roled nor
 * deleted; a project has at most one librarian; a workspace an agent points at
 * belongs to the same owner — are properties of the fleet, not of the web UI.
 * The MCP endpoint reaches the same operations from outside the browser
 * (src/lib/mcp/tools.ts), and the one thing worse than no remote control is
 * remote control that plays by different rules. So both callers go through
 * this module and the route handlers stay what they should be: parse, call,
 * serialize.
 *
 * Failures are thrown as ApiResponseError, whose status the HTTP layer renders
 * as a response and the MCP layer renders as a tool error.
 */

/** Roles a caller may assign. The manager's is fixed at project creation. */
export type AssignableRole = Extract<AgentRole, "specialist" | "librarian">;

/** Fields describing an agent's configuration, in API (camelCase) form. */
export interface AgentConfigInput {
  name?: string;
  role?: AssignableRole;
  instructions?: string;
  model?: string;
  /** null detaches the agent from its workspace. */
  workspaceId?: string | null;
  plugins?: string[];
  mcpServers?: McpServerConfig[];
  allowedTools?: string[];
  disallowedTools?: string[];
  isActive?: boolean;
}

/** Every agent of a project, oldest first — the order the UI lists them in. */
export async function listAgents(
  userId: string,
  projectId: string,
): Promise<Agent[]> {
  await requireProjectAccess(userId, projectId);
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("agents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new ApiResponseError(500, error.message);
  return (data ?? []) as Agent[];
}

/** One agent, after checking the caller owns its project. */
export async function getAgent(
  userId: string,
  agentId: string,
): Promise<Agent> {
  return requireAgentAccess(userId, agentId);
}

/**
 * Mirrors the one_librarian_per_project unique index with an error a human
 * (or a model) can act on, instead of a raw 23505 from Postgres.
 */
async function assertNoOtherLibrarian(
  projectId: string,
  exceptAgentId?: string,
): Promise<void> {
  const admin = getAdminClient();
  let query = admin
    .from("agents")
    .select("id")
    .eq("project_id", projectId)
    .eq("role", "librarian");
  if (exceptAgentId) query = query.neq("id", exceptAgentId);

  const { data, error } = await query.maybeSingle();
  if (error) throw new ApiResponseError(500, error.message);
  if (data) throw new ApiResponseError(400, "Project already has a librarian");
}

/**
 * A workspace an agent is attached to must belong to the same owner. The
 * check lives here rather than at the route because `workspaceId` arrives as
 * a bare uuid from whoever is calling: without it, any owner could pin an
 * agent to a stranger's checkout and have the worker run it there.
 */
async function assertWorkspaceOwned(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const workspace = await requireWorkspaceAccess(userId, workspaceId);
  if (workspace.project_id !== projectId) {
    throw new ApiResponseError(
      400,
      "Workspace belongs to a different project",
    );
  }
}

export async function createAgent(
  userId: string,
  projectId: string,
  input: AgentConfigInput & { name: string; role: AssignableRole },
): Promise<Agent> {
  await requireProjectAccess(userId, projectId);
  if (input.role === "librarian") await assertNoOtherLibrarian(projectId);
  if (input.workspaceId) {
    await assertWorkspaceOwned(userId, projectId, input.workspaceId);
  }
  const admin = getAdminClient();

  const { data: agent, error } = await admin
    .from("agents")
    .insert({
      project_id: projectId,
      workspace_id: input.workspaceId ?? null,
      name: input.name,
      role: input.role,
      instructions: input.instructions ?? "",
      model: input.model,
      plugins: input.plugins ?? [],
      mcp_servers: input.mcpServers ?? [],
      allowed_tools: input.allowedTools ?? [],
      disallowed_tools: input.disallowedTools ?? [],
    })
    .select()
    .single();
  if (error || !agent) {
    throw new ApiResponseError(500, error?.message ?? "Failed to create agent");
  }
  return agent as Agent;
}

export async function updateAgent(
  userId: string,
  agentId: string,
  input: AgentConfigInput,
): Promise<Agent> {
  const agent = await requireAgentAccess(userId, agentId);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.role !== undefined && input.role !== agent.role) {
    if (agent.role === "manager") {
      throw new ApiResponseError(400, "The manager agent's role cannot change.");
    }
    if (input.role === "librarian") {
      await assertNoOtherLibrarian(agent.project_id, agentId);
    }
    patch.role = input.role;
  }
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.model !== undefined) patch.model = input.model;
  if (input.workspaceId !== undefined) {
    if (input.workspaceId) {
      await assertWorkspaceOwned(userId, agent.project_id, input.workspaceId);
    }
    patch.workspace_id = input.workspaceId;
  }
  if (input.plugins !== undefined) patch.plugins = input.plugins;
  if (input.mcpServers !== undefined) patch.mcp_servers = input.mcpServers;
  if (input.allowedTools !== undefined) patch.allowed_tools = input.allowedTools;
  if (input.disallowedTools !== undefined) {
    patch.disallowed_tools = input.disallowedTools;
  }
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (Object.keys(patch).length === 0) {
    throw new ApiResponseError(400, "Nothing to update");
  }

  const { data: updated, error } = await admin
    .from("agents")
    .update(patch)
    .eq("id", agentId)
    .select()
    .single();
  if (error || !updated) {
    throw new ApiResponseError(500, error?.message ?? "Failed to update agent");
  }
  return updated as Agent;
}

export async function deleteAgent(
  userId: string,
  agentId: string,
): Promise<void> {
  const agent = await requireAgentAccess(userId, agentId);
  if (agent.role === "manager") {
    throw new ApiResponseError(400, "The manager agent cannot be deleted.");
  }
  const admin = getAdminClient();

  const { error } = await admin.from("agents").delete().eq("id", agentId);
  if (error) throw new ApiResponseError(500, error.message);
}
