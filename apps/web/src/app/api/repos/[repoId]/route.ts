import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireRepoAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ repoId: string }> };

/** DELETE /api/repos/[repoId] — remove a repo from its workspace. */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { repoId } = await params;
  const user = await requireUser();
  await requireRepoAccess(user.id, repoId);
  const admin = getAdminClient();

  const { error } = await admin.from("workspace_repos").delete().eq("id", repoId);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ ok: true });
});
