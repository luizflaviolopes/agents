import { NextResponse } from "next/server";
import { createTaskSchema } from "@agent-fleet/shared";
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

/** GET /api/projects/[id]/tasks — every task for the board (max 400). */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: tasks, error } = await admin
    .from("tasks")
    .select("*")
    .eq("project_id", id)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(400);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ tasks: tasks ?? [] });
});

/** POST /api/projects/[id]/tasks — queue a task (source 'web'). */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, createTaskSchema, {
    projectId: id,
    source: "web",
  });
  const admin = getAdminClient();

  const { data: task, error } = await admin
    .from("tasks")
    .insert({
      project_id: id,
      agent_id: input.agentId ?? null,
      created_by: user.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      status: "queued",
      source: "web",
      parent_task_id: input.parentTaskId ?? null,
    })
    .select()
    .single();
  if (error || !task) {
    return jsonError(500, error?.message ?? "Failed to create task");
  }
  return NextResponse.json({ task }, { status: 201 });
});
