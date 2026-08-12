import { NextResponse } from "next/server";
import { z } from "zod";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireTaskAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ taskId: string }> };

/** The only client-driven transition: cancel a still-queued task. */
const updateTaskSchema = z.object({
  status: z.literal("cancelled"),
});

/** GET /api/tasks/[taskId] — the task plus its runs. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { taskId } = await params;
  const user = await requireUser();
  const task = await requireTaskAccess(user.id, taskId);
  const admin = getAdminClient();

  const { data: runs, error } = await admin
    .from("task_runs")
    .select("*")
    .eq("task_id", taskId)
    .order("started_at", { ascending: false });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ task, runs: runs ?? [] });
});

/** PATCH /api/tasks/[taskId] — cancel a queued task. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { taskId } = await params;
  const user = await requireUser();
  await requireTaskAccess(user.id, taskId);
  await parseBody(request, updateTaskSchema);
  const admin = getAdminClient();

  // Guarded update: only 'queued' tasks may be cancelled.
  const { data: task, error } = await admin
    .from("tasks")
    .update({ status: "cancelled" })
    .eq("id", taskId)
    .eq("status", "queued")
    .select()
    .maybeSingle();
  if (error) return jsonError(500, error.message);
  if (!task) {
    return jsonError(409, "Only queued tasks can be cancelled.");
  }
  return NextResponse.json({ task });
});
