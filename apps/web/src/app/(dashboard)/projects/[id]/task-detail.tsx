"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  History,
  Inbox,
} from "lucide-react";
import type { RunLog, Task, TaskRun } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import {
  formatCompactNumber,
  formatDateTime,
  formatDuration,
  formatUsdPrecise,
  timeAgo,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RunStatusBadge,
  SourceBadge,
  TaskStatusBadge,
} from "@/components/badges";

export function TaskDetailDialog({
  task,
  agentName,
  onClose,
  onTaskChanged,
}: {
  task: Task | null;
  agentName: string | null;
  onClose: () => void;
  onTaskChanged: () => void;
}) {
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<string | null>(null);

  async function cancelTask() {
    if (!task) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api<{ task: Task }>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      });
      onTaskChanged();
      onClose();
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : "Failed to cancel task",
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Dialog open={Boolean(task)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {task && (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle className="leading-snug">{task.title}</DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <TaskStatusBadge status={task.status} />
                <SourceBadge source={task.source} />
                <span className="text-xs text-muted-foreground">
                  {agentName ? `Assigned to ${agentName}` : "Unassigned"}
                  {" · "}created {timeAgo(task.created_at)}
                  {task.priority !== 0 ? ` · priority ${task.priority}` : ""}
                </span>
              </div>
            </DialogHeader>

            <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
              {task.status === "review" && (
                <Link
                  href={`/projects/${task.project_id}/review`}
                  className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400 transition-colors hover:bg-amber-500/15"
                >
                  <Inbox className="size-4 shrink-0" />
                  View pending approvals → Review tab
                </Link>
              )}

              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Description
                </h3>
                <p className="whitespace-pre-wrap text-sm">
                  {task.description || (
                    <span className="text-muted-foreground">
                      No description
                    </span>
                  )}
                </p>
              </section>

              {task.result && (
                <section>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Result
                  </h3>
                  <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    {task.result}
                  </div>
                </section>
              )}

              {/* Keyed by task id so runs never leak between tasks. */}
              <TaskRunsSection key={task.id} taskId={task.id} />
            </div>

            {task.status === "queued" && (
              <div className="mt-4 flex flex-col items-end gap-2 border-t border-border pt-4">
                {cancelError && (
                  <p className="text-sm text-destructive">{cancelError}</p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancelling}
                  onClick={cancelTask}
                >
                  <CircleSlash />
                  {cancelling ? "Cancelling…" : "Cancel task"}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskRunsSection({ taskId }: { taskId: string }) {
  // Poll runs while the dialog is open (replaces the Realtime subscription).
  const { data: runs, loading } = usePolling<TaskRun[]>(
    React.useCallback(async () => {
      const { runs } = await api<{ runs: TaskRun[] }>(
        `/api/tasks/${taskId}/runs`,
      );
      return runs;
    }, [taskId]),
    3000,
    [taskId],
  );

  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Runs
      </h3>
      {loading || !runs ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : runs.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
          <History className="size-4" />
          No runs yet — a worker will pick this task up from the queue.
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunItem({ run }: { run: TaskRun }) {
  const [expanded, setExpanded] = React.useState(false);

  // Incremental log fetching: ?after=<seq> only returns new entries. While
  // the run is finished we fetch once and then stop hitting the network.
  const logsRef = React.useRef<RunLog[]>([]);
  const fetchedOnceRef = React.useRef(false);
  const runStatusRef = React.useRef(run.status);
  runStatusRef.current = run.status;

  const { data: logs } = usePolling<RunLog[]>(
    React.useCallback(async () => {
      if (fetchedOnceRef.current && runStatusRef.current !== "running") {
        return logsRef.current;
      }
      const lastSeq = logsRef.current[logsRef.current.length - 1]?.seq;
      const url =
        lastSeq !== undefined
          ? `/api/runs/${run.id}/logs?after=${lastSeq}`
          : `/api/runs/${run.id}/logs`;
      const { logs: fresh } = await api<{ logs: RunLog[] }>(url);
      if (fresh.length > 0) {
        const known = new Set(logsRef.current.map((l) => l.id));
        logsRef.current = [
          ...logsRef.current,
          ...fresh.filter((l) => !known.has(l.id)),
        ].sort((a, b) => a.seq - b.seq);
      }
      fetchedOnceRef.current = true;
      return logsRef.current;
    }, [run.id]),
    2000,
    [run.id],
    expanded,
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          {formatDateTime(run.started_at)}
        </span>
        <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">
          {runUsageSummary(run)}
          {formatDuration(run.started_at, run.finished_at)}
        </span>
      </button>
      {run.error && (
        <div className="border-t border-border bg-destructive/10 px-3 py-2 font-mono text-xs text-red-400">
          {run.error}
        </div>
      )}
      {expanded && (
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border bg-background/60 p-3">
          {logs === undefined ? (
            <>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </>
          ) : logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No log entries for this run yet.
            </p>
          ) : (
            logs.map((log) => <LogEntry key={log.id} log={log} />)
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "model · 12.3K in / 1.2K out · $0.0312 · " prefix for the run header —
 * empty when the run has no usage data (older runs, or a crash before the
 * SDK result message).
 */
function runUsageSummary(run: TaskRun): string {
  const parts: string[] = [];
  if (run.model) parts.push(run.model);
  if (run.input_tokens !== null || run.output_tokens !== null) {
    parts.push(
      `${formatCompactNumber(run.input_tokens ?? 0)} in / ${formatCompactNumber(run.output_tokens ?? 0)} out`,
    );
  }
  if (run.cost_usd !== null) parts.push(formatUsdPrecise(run.cost_usd));
  return parts.length > 0 ? `${parts.join(" · ")} · ` : "";
}

function LogEntry({ log }: { log: RunLog }) {
  const content = (log.content ?? {}) as Record<string, unknown>;

  if (log.event_type === "assistant_text") {
    const text =
      typeof content.text === "string"
        ? content.text
        : JSON.stringify(content, null, 2);
    return (
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{text}</div>
    );
  }

  if (log.event_type === "tool_use" || log.event_type === "tool_result") {
    const toolName =
      typeof content.name === "string"
        ? content.name
        : typeof content.tool_name === "string"
          ? content.tool_name
          : log.event_type;
    const payload =
      log.event_type === "tool_use"
        ? (content.input ?? content)
        : (content.content ?? content.result ?? content);
    return (
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center gap-2 bg-muted/60 px-2 py-1">
          <span className="font-mono text-xs font-semibold">{toolName}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {log.event_type === "tool_use" ? "tool call" : "result"}
          </span>
        </div>
        <pre className="max-h-48 overflow-auto p-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2)}
        </pre>
      </div>
    );
  }

  const isError = log.event_type === "error" || log.level === "error";
  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed",
        isError ? "text-red-400" : "text-muted-foreground",
      )}
    >
      [{log.event_type}] {JSON.stringify(content)}
    </pre>
  );
}
