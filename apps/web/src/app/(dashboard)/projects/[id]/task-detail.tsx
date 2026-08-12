"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, CircleSlash, History } from "lucide-react";
import type { RunLog, Task, TaskRun } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime, formatDuration, timeAgo } from "@/lib/format";
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
  onTaskChanged: (task: Task) => void;
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const [runs, setRuns] = React.useState<TaskRun[] | null>(null);
  const [cancelling, setCancelling] = React.useState(false);

  const taskId = task?.id;

  // Load runs when a task is opened, and keep them fresh via Realtime.
  React.useEffect(() => {
    if (!taskId) {
      setRuns(null);
      return;
    }
    let cancelled = false;

    supabase
      .from("task_runs")
      .select("*")
      .eq("task_id", taskId)
      .order("started_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setRuns((data ?? []) as TaskRun[]);
      });

    const channel = supabase
      .channel(`task-runs:${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "task_runs",
          filter: `task_id=eq.${taskId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const run = payload.new as TaskRun;
            setRuns((prev) =>
              prev && !prev.some((r) => r.id === run.id)
                ? [run, ...prev]
                : prev,
            );
          } else if (payload.eventType === "UPDATE") {
            const run = payload.new as TaskRun;
            setRuns(
              (prev) => prev?.map((r) => (r.id === run.id ? run : r)) ?? prev,
            );
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [taskId, supabase]);

  async function cancelTask() {
    if (!task) return;
    setCancelling(true);
    const { data } = await supabase
      .from("tasks")
      .update({ status: "cancelled" })
      .eq("id", task.id)
      .eq("status", "queued")
      .select()
      .maybeSingle();
    setCancelling(false);
    if (data) {
      onTaskChanged(data as Task);
      onClose();
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

              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Runs
                </h3>
                {runs === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                  </div>
                ) : runs.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                    <History className="size-4" />
                    No runs yet — a worker will pick this task up from the
                    queue.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {runs.map((run) => (
                      <RunItem key={run.id} run={run} />
                    ))}
                  </div>
                )}
              </section>
            </div>

            {task.status === "queued" && (
              <div className="mt-4 flex justify-end border-t border-border pt-4">
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

function RunItem({ run }: { run: TaskRun }) {
  const supabase = React.useMemo(() => createClient(), []);
  const [expanded, setExpanded] = React.useState(false);
  const [logs, setLogs] = React.useState<RunLog[] | null>(null);

  // Fetch logs when expanded; live-append new log lines while open.
  React.useEffect(() => {
    if (!expanded) return;
    let cancelled = false;

    supabase
      .from("run_logs")
      .select("*")
      .eq("run_id", run.id)
      .order("seq", { ascending: true })
      .then(({ data }) => {
        if (!cancelled) setLogs((data ?? []) as RunLog[]);
      });

    const channel = supabase
      .channel(`run-logs:${run.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "run_logs",
          filter: `run_id=eq.${run.id}`,
        },
        (payload) => {
          const log = payload.new as RunLog;
          setLogs((prev) => {
            if (!prev) return [log];
            if (prev.some((l) => l.id === log.id)) return prev;
            return [...prev, log].sort((a, b) => a.seq - b.seq);
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [expanded, run.id, supabase]);

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
        <span className="ml-auto text-xs text-muted-foreground">
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
          {logs === null ? (
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
