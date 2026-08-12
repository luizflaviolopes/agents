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
  instructions: z.string().optional(),
  model: z.string().min(1).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  plugins: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  isActive: z.boolean().optional(),
});

/** PATCH /api/agents/[agentId] — update config / toggle active. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  await requireAgentAccess(user.id, agentId);
  const input = await parseBody(request, updateAgentSchema);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.model !== undefined) patch.model = input.model;
  if (input.workspaceId !== undefined) patch.workspace_id = input.workspaceId;
  if (input.plugins !== undefined) patch.plugins = input.plugins;
  if (input.mcpServers !== undefined) patch.mcp_servers = input.mcpServers;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");

  const { data: agent, error } = await admin
    .from("agents")
    .update(patch)
    .eq("id", agentId)
    .select()
    .single();
  if (error || !agent) {
    return jsonError(500, error?.message ?? "Failed to update agent");
  }
  return NextResponse.json({ agent });
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
