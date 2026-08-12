import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireRunAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/logs — log entries ordered by seq.
 * `?after=<seq>` returns only entries with a greater seq (incremental poll).
 */
export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const { runId } = await params;
  const user = await requireUser();
  const run = await requireRunAccess(user.id, runId);
  const admin = getAdminClient();

  const afterParam = new URL(request.url).searchParams.get("after");
  let query = admin
    .from("run_logs")
    .select("*")
    .eq("run_id", runId)
    .order("seq", { ascending: true });
  if (afterParam !== null) {
    const after = Number(afterParam);
    if (!Number.isFinite(after)) return jsonError(400, "Invalid 'after' value");
    query = query.gt("seq", after);
  }

  const { data: logs, error } = await query;
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ logs: logs ?? [], runStatus: run.status });
});
