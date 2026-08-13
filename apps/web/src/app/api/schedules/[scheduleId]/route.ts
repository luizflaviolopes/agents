import { NextResponse } from "next/server";
import { updateScheduleSchema } from "@agent-fleet/shared";
import type { Agent, ScheduleKind } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireScheduleAccess,
  requireUser,
} from "@/lib/api/auth";
import {
  computeDailyNextRun,
  isValidTimezone,
} from "@/lib/api/daily-next-run";
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

  // Timing fields. Effective values = the patch merged over the stored row;
  // `kind` in the payload requires its matching field (schema refinement).
  const kind: ScheduleKind = input.kind ?? schedule.kind;
  if (input.kind !== undefined) patch.kind = input.kind;

  if (input.weekdays !== undefined) {
    if (input.weekdays.length === 0) {
      return jsonError(400, "Pick at least one weekday");
    }
    patch.weekdays = input.weekdays;
  }
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) {
      return jsonError(400, "Invalid timezone — expected an IANA name");
    }
    patch.timezone = input.timezone;
  }
  if (input.runAtTime !== undefined) patch.run_at_time = input.runAtTime;
  if (input.intervalMinutes !== undefined) {
    patch.interval_minutes = input.intervalMinutes;
  }

  if (kind === "interval") {
    const switchedKind = input.kind === "interval" && schedule.kind !== "interval";
    const minutes = input.intervalMinutes ?? schedule.interval_minutes;
    if (
      minutes != null &&
      (switchedKind ||
        (input.intervalMinutes !== undefined &&
          input.intervalMinutes !== schedule.interval_minutes))
    ) {
      // A new cadence (or a switch back to interval) restarts the clock.
      patch.next_run_at = new Date(Date.now() + minutes * 60_000).toISOString();
    }
  } else {
    // Daily: recompute next_run_at whenever any timing input changed. The
    // worker recomputes on every fire; the route computes the first
    // occurrence so the edit takes effect without firing immediately.
    const timingChanged =
      input.kind !== undefined ||
      input.runAtTime !== undefined ||
      input.weekdays !== undefined ||
      input.timezone !== undefined;
    if (timingChanged) {
      const runAtTime =
        input.runAtTime ?? (schedule.run_at_time ?? "").slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(runAtTime)) {
        return jsonError(400, "runAtTime is required for a daily schedule");
      }
      const weekdays = input.weekdays ?? schedule.weekdays;
      const timezone = input.timezone ?? schedule.timezone;
      if (!isValidTimezone(timezone)) {
        return jsonError(400, "Invalid timezone — expected an IANA name");
      }
      patch.next_run_at = computeDailyNextRun(
        runAtTime,
        weekdays,
        timezone,
      ).toISOString();
    }
  }

  if (input.enabled !== undefined) {
    patch.enabled = input.enabled;
    // Re-enabling an interval schedule fires as soon as the worker's
    // schedule loop next scans; a daily schedule waits for its next slot.
    if (input.enabled && !schedule.enabled && patch.next_run_at === undefined) {
      patch.next_run_at =
        kind === "daily" && schedule.run_at_time
          ? computeDailyNextRun(
              schedule.run_at_time.slice(0, 5),
              schedule.weekdays,
              schedule.timezone,
            ).toISOString()
          : new Date().toISOString();
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
