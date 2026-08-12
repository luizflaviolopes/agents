import { NextResponse } from "next/server";
import { PENDING_ACTION_STATUSES } from "@agent-fleet/shared";
import type { PendingActionStatus } from "@agent-fleet/shared";
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
 * GET /api/projects/[id]/pending-actions — the project's proposed outbound
 * actions for the Review inbox, newest first, with the proposing agent's
 * name and the originating task's title joined in. Optional `?status=`
 * filter (e.g. `?status=pending` for the tab badge).
 */
export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const status = new URL(request.url).searchParams.get("status");
  if (
    status !== null &&
    !PENDING_ACTION_STATUSES.includes(status as PendingActionStatus)
  ) {
    return jsonError(400, "Invalid status filter");
  }

  let query = admin
    .from("pending_actions")
    .select("*, agent:agents(name), task:tasks(title)")
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (status) query = query.eq("status", status);

  const { data: actions, error } = await query;
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ actions: actions ?? [] });
});
