import { NextResponse } from "next/server";
import { addWorkspaceRepoSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireUser,
  requireWorkspaceAccess,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ wsId: string }> };

/** POST /api/workspaces/[wsId]/repos — add a repo (worker clones it). */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { wsId } = await params;
  const user = await requireUser();
  await requireWorkspaceAccess(user.id, wsId);
  const input = await parseBody(request, addWorkspaceRepoSchema, {
    workspaceId: wsId,
  });

  const admin = getAdminClient();
  const { data: repo, error } = await admin
    .from("workspace_repos")
    .insert({
      workspace_id: wsId,
      repo_url: input.repoUrl,
      branch: input.branch,
      folder_name: input.folderName,
    })
    .select()
    .single();
  if (error || !repo) {
    return jsonError(500, error?.message ?? "Failed to add repository");
  }
  return NextResponse.json({ repo }, { status: 201 });
});
