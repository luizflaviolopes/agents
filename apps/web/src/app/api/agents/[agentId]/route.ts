import { NextResponse } from "next/server";
import { z } from "zod";
import { mcpServerSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireAgentAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agentId: string }> };

const updateAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Managers keep their role; specialist ↔ librarian is allowed. */
  role: z.enum(["specialist", "librarian"]).optional(),
  instructions: z.string().optional(),
  model: z.string().min(1).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  plugins: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

/** PATCH /api/agents/[agentId] — update config / toggle active. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  const agent = await requireAgentAccess(user.id, agentId);
  const input = await parseBody(request, updateAgentSchema);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.role !== undefined && input.role !== agent.role) {
    if (agent.role === "manager") {
      return jsonError(400, "The manager agent's role cannot change.");
    }
    if (input.role === "librarian") {
      // Mirrors the one_librarian_per_project unique index with a clear
      // error.
      const { data: librarian, error: librarianError } = await admin
        .from("agents")
        .select("id")
        .eq("project_id", agent.project_id)
        .eq("role", "librarian")
        .neq("id", agentId)
        .maybeSingle();
      if (librarianError) return jsonError(500, librarianError.message);
      if (librarian) return jsonError(400, "Project already has a librarian");
    }
    patch.role = input.role;
  }
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.model !== undefined) patch.model = input.model;
  if (input.workspaceId !== undefined) patch.workspace_id = input.workspaceId;
  if (input.plugins !== undefined) patch.plugins = input.plugins;
  if (input.mcpServers !== undefined) patch.mcp_servers = input.mcpServers;
  if (input.allowedTools !== undefined) patch.allowed_tools = input.allowedTools;
  if (input.disallowedTools !== undefined) patch.disallowed_tools = input.disallowedTools;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");

  const { data: updated, error } = await admin
    .from("agents")
    .update(patch)
    .eq("id", agentId)
    .select()
    .single();
  if (error || !updated) {
    return jsonError(500, error?.message ?? "Failed to update agent");
  }
  return NextResponse.json({ agent: updated });
});

/** DELETE /api/agents/[agentId] — delete a specialist (managers are kept). */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  const agent = await requireAgentAccess(user.id, agentId);
  if (agent.role === "manager") {
    return jsonError(400, "The manager agent cannot be deleted.");
  }
  const admin = getAdminClient();

  const { error } = await admin.from("agents").delete().eq("id", agentId);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ ok: true });
});
