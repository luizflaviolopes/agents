import { NextResponse } from "next/server";
import type { Workspace } from "@agent-fleet/shared";
import { createWorkspaceSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";
import { slugify } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/workspaces — the project's workspaces plus every
 * repo in them (the workspaces panel polls this for clone statuses).
 */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: workspaces, error: wsError } = await admin
    .from("workspaces")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  if (wsError) return jsonError(500, wsError.message);

  const workspaceIds = ((workspaces ?? []) as Workspace[]).map((w) => w.id);
  let repos: unknown[] = [];
  if (workspaceIds.length > 0) {
    const { data, error } = await admin
      .from("workspace_repos")
      .select("*")
      .in("workspace_id", workspaceIds)
      .order("created_at", { ascending: true });
    if (error) return jsonError(500, error.message);
    repos = data ?? [];
  }

  return NextResponse.json({ workspaces: workspaces ?? [], repos });
});

/** POST /api/projects/[id]/workspaces — create a workspace. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, createWorkspaceSchema, {
    projectId: id,
  });

  const path = slugify(input.name);
  if (!path) {
    return jsonError(400, "Name must contain at least one letter or digit.");
  }

  const admin = getAdminClient();
  const { data: workspace, error } = await admin
    .from("workspaces")
    .insert({ project_id: id, name: input.name, path })
    .select()
    .single();
  if (error || !workspace) {
    return jsonError(500, error?.message ?? "Failed to create workspace");
  }
  return NextResponse.json({ workspace }, { status: 201 });
});
