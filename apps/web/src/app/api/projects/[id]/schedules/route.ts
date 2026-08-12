import { NextResponse } from "next/server";
import { createScheduleSchema } from "@agent-fleet/shared";
import type { Agent } from "@agent-fleet/shared";
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

/** GET /api/projects/[id]/schedules — the project's schedules + agent name. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: schedules, error } = await admin
    .from("schedules")
    .select("*, agent:agents(name)")
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ schedules: schedules ?? [] });
});

/** POST /api/projects/[id]/schedules — create a recurring task template. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, createScheduleSchema, {
    projectId: id,
  });
  const admin = getAdminClient();

  // The assigned agent must belong to this project.
  const { data: agent, error: agentError } = await admin
    .from("agents")
    .select("id, project_id")
    .eq("id", input.agentId)
    .maybeSingle();
  if (agentError) return jsonError(500, agentError.message);
  if (!agent || (agent as Pick<Agent, "id" | "project_id">).project_id !== id) {
    return jsonError(400, "Agent does not belong to this project");
  }

  const { data: schedule, error } = await admin
    .from("schedules")
    .insert({
      project_id: id,
      agent_id: input.agentId,
      name: input.name,
      interval_minutes: input.intervalMinutes,
      task_title: input.taskTitle,
      task_description: input.taskDescription ?? "",
      enabled: input.enabled,
      next_run_at: new Date().toISOString(),
    })
    .select("*, agent:agents(name)")
    .single();
  if (error || !schedule) {
    return jsonError(500, error?.message ?? "Failed to create schedule");
  }
  return NextResponse.json({ schedule }, { status: 201 });
});
