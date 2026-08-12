import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireTaskAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ taskId: string }> };

/** GET /api/tasks/[taskId]/runs — run attempts, newest first. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { taskId } = await params;
  const user = await requireUser();
  await requireTaskAccess(user.id, taskId);
  const admin = getAdminClient();

  const { data: runs, error } = await admin
    .from("task_runs")
    .select("*")
    .eq("task_id", taskId)
    .order("started_at", { ascending: false });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ runs: runs ?? [] });
});
