import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/activity — the latest 50 task runs across the
 * project, joined with task title and agent name, newest first.
 */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: runs, error } = await admin
    .from("task_runs")
    .select(
      "id, status, error, started_at, finished_at, task:tasks!inner(id, title, project_id), agent:agents(id, name)",
    )
    .eq("task.project_id", id)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ runs: runs ?? [] });
});
