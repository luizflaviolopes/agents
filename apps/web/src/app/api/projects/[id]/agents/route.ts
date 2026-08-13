import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/projects/[id]/agents — the project's agents. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: agents, error } = await admin
    .from("agents")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ agents: agents ?? [] });
});

/**
 * Creatable roles: specialists and (at most one) librarian. The manager is
 * created with the project and can never be added here.
 */
const createAgentWithRoleSchema = createAgentSchema.extend({
  role: z.enum(["specialist", "librarian"]).default("specialist"),
});

/** POST /api/projects/[id]/agents — create a specialist/librarian agent. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, createAgentWithRoleSchema, {
    projectId: id,
  });
  const admin = getAdminClient();

  if (input.role === "librarian") {
    // Mirrors the one_librarian_per_project unique index with a clear error.
    const { data: librarian, error: librarianError } = await admin
      .from("agents")
      .select("id")
      .eq("project_id", id)
      .eq("role", "librarian")
      .maybeSingle();
    if (librarianError) return jsonError(500, librarianError.message);
    if (librarian) return jsonError(400, "Project already has a librarian");
  }

  const { data: agent, error } = await admin
    .from("agents")
    .insert({
      project_id: id,
      workspace_id: input.workspaceId ?? null,
      name: input.name,
      role: input.role,
      instructions: input.instructions,
      model: input.model,
      plugins: input.plugins,
      mcp_servers: input.mcpServers,
    })
    .select()
    .single();
  if (error || !agent) {
    return jsonError(500, error?.message ?? "Failed to create agent");
  }
  return NextResponse.json({ agent }, { status: 201 });
});
