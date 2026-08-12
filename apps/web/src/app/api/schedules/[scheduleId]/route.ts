import { NextResponse } from "next/server";
import { updateScheduleSchema } from "@agent-fleet/shared";
import type { Agent } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireScheduleAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ scheduleId: string }> };

/** PATCH /api/schedules/[scheduleId] — update a schedule. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { scheduleId } = await params;
  const user = await requireUser();
  const schedule = await requireScheduleAccess(user.id, scheduleId);
  const input = await parseBody(request, updateScheduleSchema);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.taskTitle !== undefined) patch.task_title = input.taskTitle;
  if (input.taskDescription !== undefined) {
    patch.task_description = input.taskDescription;
  }
  if (input.agentId !== undefined && input.agentId !== schedule.agent_id) {
    // Reassignment must stay inside the schedule's project.
    const { data: agent, error: agentError } = await admin
      .from("agents")
      .select("id, project_id")
      .eq("id", input.agentId)
      .maybeSingle();
    if (agentError) return jsonError(500, agentError.message);
    if (
      !agent ||
      (agent as Pick<Agent, "id" | "project_id">).project_id !==
        schedule.project_id
    ) {
      return jsonError(400, "Agent does not belong to this project");
    }
    patch.agent_id = input.agentId;
  }
  if (
    input.intervalMinutes !== undefined &&
    input.intervalMinutes !== schedule.interval_minutes
  ) {
    patch.interval_minutes = input.intervalMinutes;
    // A new cadence restarts the clock from now.
    patch.next_run_at = new Date(
      Date.now() + input.intervalMinutes * 60_000,
    ).toISOString();
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    // Re-enabling fires as soon as the worker's schedule loop next scans.
    if (input.enabled && !schedule.enabled) {
      patch.next_run_at = new Date().toISOString();
    }
  }
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");

  const { data: updated, error } = await admin
    .from("schedules")
    .update(patch)
    .eq("id", scheduleId)
    .select("*, agent:agents(name)")
    .single();
  if (error || !updated) {
    return jsonError(500, error?.message ?? "Failed to update schedule");
  }
  return NextResponse.json({ schedule: updated });
});

/** DELETE /api/schedules/[scheduleId] — remove a schedule. */
export const DELETE = apiHandler(
  async (_request: Request, { params }: Params) => {
    const { scheduleId } = await params;
    const user = await requireUser();
    await requireScheduleAccess(user.id, scheduleId);
    const admin = getAdminClient();

    const { error } = await admin
      .from("schedules")
      .delete()
      .eq("id", scheduleId);
    if (error) return jsonError(500, error.message);
    return NextResponse.json({ ok: true });
  },
);
