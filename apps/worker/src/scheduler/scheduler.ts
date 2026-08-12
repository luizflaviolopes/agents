import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduleRow } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

const TICK_INTERVAL_MS = 30_000;
const MAX_DUE_PER_TICK = 50;

/**
 * Fires recurring task templates (the `schedules` table).
 *
 * Every 30s: for each enabled schedule whose next_run_at is due, insert a
 * queued task (source 'schedule') for the schedule's agent and advance
 * next_run_at by interval_minutes. If an identical schedule-created task is
 * still open (queued/in_progress), the insert is skipped — next_run_at is
 * still advanced so a slow task never causes a pile-up of duplicates.
 *
 * Defensive: every failure is caught and logged; the loop never throws.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = false;

  constructor(private readonly supabase: SupabaseClient) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    void this.tick();
    logger.info("scheduler", `started (checking due schedules every ${TICK_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const { data, error } = await this.supabase
        .from("schedules")
        .select("*")
        .eq("enabled", true)
        .lte("next_run_at", new Date().toISOString())
        .order("next_run_at", { ascending: true })
        .limit(MAX_DUE_PER_TICK);
      if (error) {
        logger.error("scheduler", `failed to load due schedules: ${error.message}`);
        return;
      }
      for (const schedule of (data ?? []) as ScheduleRow[]) {
        if (this.stopped) break;
        await this.fire(schedule);
      }
    } catch (err) {
      logger.error("scheduler", "tick crashed", err);
    } finally {
      this.ticking = false;
    }
  }

  private async fire(schedule: ScheduleRow): Promise<void> {
    try {
      const now = new Date();
      const nextRunAt = new Date(
        now.getTime() + schedule.interval_minutes * 60_000,
      ).toISOString();

      // Pile-up guard: skip when the previous schedule-created task for this
      // agent + title is still open.
      const { data: open, error: openError } = await this.supabase
        .from("tasks")
        .select("id")
        .eq("agent_id", schedule.agent_id)
        .eq("title", schedule.task_title)
        .eq("source", "schedule")
        .in("status", ["queued", "in_progress"])
        .limit(1);
      if (openError) {
        logger.error("scheduler", `schedule ${schedule.id} ("${schedule.name}"): open-task check failed: ${openError.message}`);
        return; // retried next tick
      }

      if ((open ?? []).length > 0) {
        logger.info("scheduler", `schedule ${schedule.id} ("${schedule.name}"): previous task still open — skipping this run`);
        const { error: skipError } = await this.supabase
          .from("schedules")
          .update({ next_run_at: nextRunAt })
          .eq("id", schedule.id);
        if (skipError) {
          logger.error("scheduler", `schedule ${schedule.id}: failed to advance next_run_at after skip: ${skipError.message}`);
        }
        return;
      }

      const { data: task, error: insertError } = await this.supabase
        .from("tasks")
        .insert({
          project_id: schedule.project_id,
          agent_id: schedule.agent_id,
          source: "schedule",
          title: schedule.task_title,
          description: schedule.task_description ?? "",
          status: "queued",
        })
        .select("id")
        .single();
      if (insertError) {
        logger.error("scheduler", `schedule ${schedule.id} ("${schedule.name}"): task insert failed: ${insertError.message}`);
        return; // retried next tick (next_run_at not advanced)
      }

      const { error: updateError } = await this.supabase
        .from("schedules")
        .update({ last_run_at: now.toISOString(), next_run_at: nextRunAt })
        .eq("id", schedule.id);
      if (updateError) {
        logger.error("scheduler", `schedule ${schedule.id}: failed to advance next_run_at: ${updateError.message}`);
      }

      logger.info(
        "scheduler",
        `schedule ${schedule.id} ("${schedule.name}") fired — created task ${(task as { id: string }).id}, next run at ${nextRunAt}`,
      );
    } catch (err) {
      logger.error("scheduler", `schedule ${schedule.id} ("${schedule.name}") crashed`, err);
    }
  }
}
