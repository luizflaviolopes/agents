import { NextResponse } from "next/server";
import { z } from "zod";
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

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

/** GET /api/projects/[id] — project + agents + workspaces summary. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  const project = await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const [{ data: agents, error: agentsError }, { data: workspaces, error: wsError }] =
    await Promise.all([
      admin
        .from("agents")
        .select("*")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
      admin
        .from("workspaces")
        .select("*")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
    ]);
  if (agentsError) return jsonError(500, agentsError.message);
  if (wsError) return jsonError(500, wsError.message);

  return NextResponse.json({
    project,
    agents: agents ?? [],
    workspaces: workspaces ?? [],
  });
});

/** PATCH /api/projects/[id] — update name/description. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, updateProjectSchema);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");

  const { data: project, error } = await admin
    .from("projects")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error || !project) {
    return jsonError(500, error?.message ?? "Failed to update project");
  }
  return NextResponse.json({ project });
});

/** DELETE /api/projects/[id] — delete the project (cascades in Postgres). */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { error } = await admin.from("projects").delete().eq("id", id);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ ok: true });
});
