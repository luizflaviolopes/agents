import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireUser,
  requireWorkspaceAccess,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ wsId: string }> };

/** DELETE /api/workspaces/[wsId] — remove a workspace (repos cascade). */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { wsId } = await params;
  const user = await requireUser();
  await requireWorkspaceAccess(user.id, wsId);
  const admin = getAdminClient();

  const { error } = await admin.from("workspaces").delete().eq("id", wsId);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ ok: true });
});
