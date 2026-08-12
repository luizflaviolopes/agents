import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";
import type { Semaphore } from "../lib/semaphore.js";

const POLL_INTERVAL_MS = 3_000;
const AGENTS_REFRESH_MS = 30_000;
export const MAX_CONCURRENT_TASKS = 2;

/**
 * Claims queued tasks via the claim_next_task RPC and hands them to the
 * executor. Polls every 3s and additionally wakes instantly on Realtime
 * INSERTs on tasks (Realtime is a hint; the RPC is the source of truth).
 *
 * Concurrency is bounded by a shared Semaphore rather than a local counter:
 * the executor's ask_agent tool releases its slot while it waits on a child
 * task (and re-acquires before resuming), so the poller must observe those
 * mid-run releases to claim the child task.
 */
export class TaskPoller {
  private pollTimer: NodeJS.Timeout | undefined;
  private agentsTimer: NodeJS.Timeout | undefined;
  private channel: RealtimeChannel | undefined;
  private agentIds: string[] = [];
  private polling = false;
  private stopped = false;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly slots: Semaphore,
    private readonly executeTask: (task: Task) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshAgents();
    this.agentsTimer = setInterval(() => void this.refreshAgents(), AGENTS_REFRESH_MS);
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    this.subscribeRealtime();
    void this.poll();
    logger.info("poller", `started (poll every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_CONCURRENT_TASKS} concurrent tasks)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.agentsTimer) clearInterval(this.agentsTimer);
    this.pollTimer = undefined;
    this.agentsTimer = undefined;
    if (this.channel) {
      try {
        await this.supabase.removeChannel(this.channel);
      } catch (err) {
        logger.warn("poller", "failed to remove realtime channel", err);
      }
      this.channel = undefined;
    }
  }

  private subscribeRealtime(): void {
    try {
      this.channel = this.supabase
        .channel("worker-task-inserts")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "tasks" },
          () => {
            void this.poll();
          },
        )
        .subscribe((status) => {
          logger.info("poller", `realtime subscription status: ${status}`);
        });
    } catch (err) {
      logger.error("poller", "realtime subscription failed (polling still active)", err);
    }
  }

  private async refreshAgents(): Promise<void> {
    try {
      const { data, error } = await this.supabase
        .from("agents")
        .select("id")
        .eq("is_active", true);
      if (error) {
        logger.error("poller", `failed to refresh agents: ${error.message}`);
        return;
      }
      this.agentIds = (data ?? []).map((row) => (row as { id: string }).id);
    } catch (err) {
      logger.error("poller", "failed to refresh agents", err);
    }
  }

  /** Claims tasks until the queue is empty or the concurrency cap is hit. */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      while (!this.stopped && this.agentIds.length > 0) {
        if (!this.slots.tryAcquire()) break; // pool full (or parents resuming)

        let claimed = false;
        try {
          const { data, error } = await this.supabase.rpc("claim_next_task", {
            p_agent_ids: this.agentIds,
          });
          if (error) {
            logger.error("poller", `claim_next_task failed: ${error.message}`);
            break;
          }
          const task = (data ?? null) as Task | null;
          if (!task || !task.id) break; // queue empty

          claimed = true;
          logger.info("poller", `claimed task ${task.id} ("${task.title}") — ${MAX_CONCURRENT_TASKS - this.slots.available}/${MAX_CONCURRENT_TASKS} slots in use`);
          void this.executeTask(task)
            .catch((err) => {
              logger.error("poller", `executeTask threw for task ${task.id}`, err);
            })
            .finally(() => {
              this.slots.release();
              void this.poll();
            });
        } finally {
          if (!claimed) this.slots.release();
        }
      }
    } catch (err) {
      logger.error("poller", "poll loop crashed", err);
    } finally {
      this.polling = false;
    }
  }
}
