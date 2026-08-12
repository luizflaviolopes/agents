import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LogLevel as DbLogLevel,
  RunLogEventType,
} from "@agent-fleet/shared";

type ConsoleLevel = "debug" | "info" | "warn" | "error";

function write(level: ConsoleLevel, scope: string, message: string, ...meta: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  // eslint-disable-next-line no-console
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta.length > 0) fn(line, ...meta);
  else fn(line);
}

/** Console logger with ISO timestamps, scoped per subsystem. */
export const logger = {
  debug: (scope: string, message: string, ...meta: unknown[]) => write("debug", scope, message, ...meta),
  info: (scope: string, message: string, ...meta: unknown[]) => write("info", scope, message, ...meta),
  warn: (scope: string, message: string, ...meta: unknown[]) => write("warn", scope, message, ...meta),
  error: (scope: string, message: string, ...meta: unknown[]) => write("error", scope, message, ...meta),
};

/**
 * Writes structured events into the run_logs table for a single task run.
 * Never throws — failures to persist a log line are reported to the console
 * so a logging hiccup can never take down a task execution.
 */
export class RunLogWriter {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly runId: string,
  ) {}

  async write(
    eventType: RunLogEventType,
    content: Record<string, unknown>,
    level: DbLogLevel = "info",
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from("run_logs").insert({
        run_id: this.runId,
        level,
        event_type: eventType,
        content,
      });
      if (error) {
        logger.error("run-logs", `failed to insert run log (${eventType}): ${error.message}`);
      }
    } catch (err) {
      logger.error("run-logs", `failed to insert run log (${eventType})`, err);
    }
  }
}
