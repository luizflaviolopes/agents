"use client";

import * as React from "react";
import { ArrowUp, ListTodo, Plus } from "lucide-react";
import type { Agent, Task, TaskStatus } from "@agent-fleet/shared";
import { createTaskSchema } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
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
  initialTasks,
  agents,
  initialTaskId,
}: {
  projectId: string;
  initialTasks: Task[];
  agents: Agent[];
  initialTaskId?: string;
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const [tasks, setTasks] = React.useState<Task[]>(initialTasks);
  const [selectedTask, setSelectedTask] = React.useState<Task | null>(null);
  const [newTaskOpen, setNewTaskOpen] = React.useState(false);

  const agentName = React.useCallback(
    (agentId: string | null) =>
      agents.find((a) => a.id === agentId)?.name ?? null,
    [agents],
  );

  // Open the task referenced by ?task=… (deep link from the Activity feed).
  React.useEffect(() => {
    if (!initialTaskId) return;
    const known = initialTasks.find((t) => t.id === initialTaskId);
    if (known) {
      setSelectedTask(known);
      return;
    }
    supabase
      .from("tasks")
      .select("*")
      .eq("id", initialTaskId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setSelectedTask(data as Task);
      });
  }, [initialTaskId, initialTasks, supabase]);

  // Realtime: keep the board in sync with the queue.
  React.useEffect(() => {
    const channel = supabase
      .channel(`board:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const task = payload.new as Task;
            setTasks((prev) =>
              prev.some((t) => t.id === task.id) ? prev : [task, ...prev],
            );
          } else if (payload.eventType === "UPDATE") {
            const task = payload.new as Task;
            setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
            setSelectedTask((sel) => (sel?.id === task.id ? task : sel));
          } else if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<Task>;
            setTasks((prev) => prev.filter((t) => t.id !== old.id));
            setSelectedTask((sel) => (sel?.id === old.id ? null : sel));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, supabase]);

  const visibleTasks = tasks.filter((t) => t.status !== "cancelled");

  return (
    <div className="flex h-full flex-col px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {visibleTasks.length} task{visibleTasks.length === 1 ? "" : "s"} on
          the board — updates live
        </p>
        <Button size="sm" onClick={() => setNewTaskOpen(true)}>
          <Plus />
          New task
        </Button>
      </div>

      {visibleTasks.length === 0 ? (
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
        <div className="grid flex-1 grid-cols-1 items-start gap-4 md:grid-cols-3 xl:grid-cols-5">
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
                className="flex min-h-[16rem] flex-col rounded-lg border border-border/60 bg-card/40"
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
        onCreated={(task) =>
          setTasks((prev) =>
            prev.some((t) => t.id === task.id) ? prev : [task, ...prev],
          )
        }
      />

      <TaskDetailDialog
        task={selectedTask}
        agentName={agentName(selectedTask?.agent_id ?? null)}
        onClose={() => setSelectedTask(null)}
        onTaskChanged={(task) =>
          setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
        }
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
  onCreated: (task: Task) => void;
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
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error: insertError } = await supabase
      .from("tasks")
      .insert({
        project_id: parsed.data.projectId,
        agent_id: parsed.data.agentId,
        created_by: user?.id ?? null,
        title: parsed.data.title,
        description: parsed.data.description,
        priority: parsed.data.priority,
        source: parsed.data.source,
      })
      .select()
      .single();

    setBusy(false);
    if (insertError || !data) {
      setError(insertError?.message ?? "Failed to create task");
      return;
    }

    onCreated(data as Task);
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
