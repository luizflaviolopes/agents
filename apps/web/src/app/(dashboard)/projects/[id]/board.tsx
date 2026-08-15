"use client";

import * as React from "react";
import { ArrowUp, ListTodo, Plus } from "lucide-react";
import type { Agent, Task, TaskStatus } from "@agent-fleet/shared";
import { createTaskSchema } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SourceBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { TaskDetailDialog } from "./task-detail";

const COLUMNS: { status: TaskStatus; label: string; dot: string }[] = [
  { status: "queued", label: "Queued", dot: "bg-zinc-400" },
  { status: "in_progress", label: "In progress", dot: "bg-indigo-400" },
  { status: "review", label: "Review", dot: "bg-amber-400" },
  { status: "done", label: "Done", dot: "bg-emerald-400" },
  { status: "failed", label: "Failed", dot: "bg-red-400" },
];

export function Board({
  projectId,
  agents,
  initialTaskId,
}: {
  projectId: string;
  agents: Agent[];
  initialTaskId?: string;
}) {
  // Poll the queue every 3s (replaces the old Realtime subscription).
  const {
    data: tasks,
    loading,
    refresh,
  } = usePolling<Task[]>(
    React.useCallback(async () => {
      const { tasks } = await api<{ tasks: Task[] }>(
        `/api/projects/${projectId}/tasks`,
      );
      return tasks;
    }, [projectId]),
    3000,
    [projectId],
  );

  const [selectedTask, setSelectedTask] = React.useState<Task | null>(null);
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);

  const agentName = React.useCallback(
    (agentId: string | null) =>
      agents.find((a) => a.id === agentId)?.name ?? null,
    [agents],
  );

  // Keep the open dialog's task in sync with the freshest polled copy.
  React.useEffect(() => {
    if (!tasks) return;
    setSelectedTask((sel) => {
      if (!sel) return sel;
      return tasks.find((t) => t.id === sel.id) ?? sel;
    });
  }, [tasks]);

  // Open the task referenced by ?task=… (deep link from the Activity feed).
  const deepLinkDone = React.useRef(false);
  React.useEffect(() => {
    if (!initialTaskId || !tasks || deepLinkDone.current) return;
    deepLinkDone.current = true;
    const known = tasks.find((t) => t.id === initialTaskId);
    if (known) {
      setSelectedTask(known);
      return;
    }
    api<{ task: Task }>(`/api/tasks/${initialTaskId}`)
      .then(({ task }) => setSelectedTask(task))
      .catch(() => undefined);
  }, [initialTaskId, tasks]);

  const visibleTasks = (tasks ?? []).filter((t) => t.status !== "cancelled");

  return (
    <div className="flex h-full flex-col px-4 py-4 sm:px-8 sm:py-6">
      <div className="mb-4 flex items-center justify-between gap-3 sm:mb-5">
        <p className="text-sm text-muted-foreground">
          {visibleTasks.length} task{visibleTasks.length === 1 ? "" : "s"} on
          the board — refreshes automatically
        </p>
        <Button size="sm" onClick={() => setNewTaskOpen(true)}>
          <Plus />
          New task
        </Button>
      </div>

      {loading ? (
        <div className="grid flex-1 grid-cols-2 items-start gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-5">
          {COLUMNS.map((column) => (
            <Skeleton key={column.status} className="h-40" />
          ))}
        </div>
      ) : visibleTasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet"
          description="Create a task manually, or ask the manager in Chat and it will queue work for your agents."
          action={
            <Button onClick={() => setNewTaskOpen(true)}>
              <Plus />
              New task
            </Button>
          }
        />
      ) : (
        // Mobile: one horizontally-snapping row of columns; md+: a grid.
        <div className="no-scrollbar -mx-4 flex flex-1 snap-x snap-mandatory items-start gap-3 overflow-x-auto px-4 sm:-mx-8 sm:px-8 md:mx-0 md:grid md:snap-none md:grid-cols-3 md:gap-4 md:overflow-visible md:px-0 xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const columnTasks = visibleTasks
              .filter((t) => t.status === column.status)
              .sort(
                (a, b) =>
                  b.priority - a.priority ||
                  (b.created_at ?? "").localeCompare(a.created_at ?? ""),
              );
            return (
              <div
                key={column.status}
                className="flex min-h-[16rem] w-[80vw] max-w-72 shrink-0 snap-start flex-col rounded-lg border border-border/60 bg-card/40 md:w-auto md:max-w-none"
              >
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn("size-1.5 rounded-full", column.dot)} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {column.label}
                  </span>
                  <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {columnTasks.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 px-2 pb-2">
                  {columnTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTask(task)}
                      className="rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/40"
                    >
                      <div className="line-clamp-2 text-sm font-medium leading-snug">
                        {task.title}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <SourceBadge source={task.source} />
                        {task.priority !== 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            <ArrowUp className="size-3" />
                            {task.priority}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                        <span className="truncate">
                          {agentName(task.agent_id) ?? "Unassigned"}
                        </span>
                        <span className="shrink-0">
                          {timeAgo(task.created_at)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={projectId}
        agents={agents}
        onCreated={refresh}
      />

      <TaskDetailDialog
        task={selectedTask}
        agentName={agentName(selectedTask?.agent_id ?? null)}
        onClose={() => setSelectedTask(null)}
        onTaskChanged={refresh}
      />
    </div>
  );
}

function NewTaskDialog({
  open,
  onOpenChange,
  projectId,
  agents,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  agents: Agent[];
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [priority, setPriority] = React.useState("0");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const activeAgents = agents.filter((a) => a.is_active);

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = createTaskSchema.safeParse({
      projectId,
      agentId: agentId || null,
      title: title.trim(),
      description,
      priority: Number.parseInt(priority, 10) || 0,
      source: "web",
    });
    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }

    setBusy(true);
    try {
      await api<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          agentId: parsed.data.agentId,
          title: parsed.data.title,
          description: parsed.data.description,
          priority: parsed.data.priority,
        }),
      });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Failed to create task");
      return;
    }
    setBusy(false);

    onCreated();
    onOpenChange(false);
    setTitle("");
    setDescription("");
    setAgentId("");
    setPriority("0");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Queue a task for one of this project&apos;s agents.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={createTask} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              placeholder="Fix the flaky signup test"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              placeholder="Everything the agent needs to know to do this work."
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="task-agent">Assignee</Label>
              <Select
                id="task-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.role === "manager" ? " (manager)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-priority">Priority</Label>
              <Input
                id="task-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
