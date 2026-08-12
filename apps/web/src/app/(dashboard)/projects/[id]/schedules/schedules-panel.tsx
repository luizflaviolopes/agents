"use client";

import * as React from "react";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import type { Agent, ScheduleRow } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";

/** Schedule + the agent name joined in by the API. */
interface ScheduleJoined extends ScheduleRow {
  agent: { name: string } | null;
}

/** "in 5m" style relative future timestamp (next_run_at). */
function timeUntil(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function SchedulesPanel({
  projectId,
  agents,
}: {
  projectId: string;
  agents: Agent[];
}) {
  // Poll every 10s — schedules change slowly; last/next run times drift.
  const { data, loading, refresh } = usePolling<ScheduleJoined[]>(
    React.useCallback(async () => {
      const { schedules } = await api<{ schedules: ScheduleJoined[] }>(
        `/api/projects/${projectId}/schedules`,
      );
      return schedules;
    }, [projectId]),
    10000,
    [projectId],
  );

  const schedules = data ?? [];
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editSchedule, setEditSchedule] = React.useState<ScheduleJoined | null>(
    null,
  );
  const [deleteSchedule, setDeleteSchedule] =
    React.useState<ScheduleJoined | null>(null);

  async function toggleEnabled(schedule: ScheduleJoined, enabled: boolean) {
    try {
      await api(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
    } finally {
      refresh();
    }
  }

  async function remove(schedule: ScheduleJoined) {
    try {
      await api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
    } finally {
      refresh();
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Recurring tasks — the worker queues each one for its agent on the
          interval.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          New schedule
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description="Create a schedule to queue a recurring task for one of your agents — e.g. a Slack digest every 30 minutes."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New schedule
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {schedules.map((schedule) => (
            <Card
              key={schedule.id}
              className={!schedule.enabled ? "opacity-60" : ""}
            >
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{schedule.name}</div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {schedule.agent?.name ?? "Unknown agent"} · every{" "}
                    {schedule.interval_minutes} min
                  </p>
                </div>
                <Switch
                  checked={schedule.enabled}
                  onCheckedChange={(checked) =>
                    toggleEnabled(schedule, checked)
                  }
                />
              </CardHeader>
              <CardContent>
                <p className="truncate text-sm">{schedule.task_title}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Last run:{" "}
                    {schedule.last_run_at
                      ? timeAgo(schedule.last_run_at)
                      : "never"}
                  </span>
                  <span>
                    Next run:{" "}
                    {schedule.enabled ? timeUntil(schedule.next_run_at) : "—"}
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditSchedule(schedule)}
                  >
                    <Pencil />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteSchedule(schedule)}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ScheduleFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        agents={agents}
        onSaved={refresh}
      />

      <ScheduleFormDialog
        open={Boolean(editSchedule)}
        onOpenChange={(o) => !o && setEditSchedule(null)}
        projectId={projectId}
        agents={agents}
        schedule={editSchedule}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={Boolean(deleteSchedule)}
        onOpenChange={(open) => !open && setDeleteSchedule(null)}
        title={`Delete schedule "${deleteSchedule?.name}"?`}
        description="The recurring task will stop being queued. Tasks already created are unaffected."
        onConfirm={async () => {
          if (deleteSchedule) await remove(deleteSchedule);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

const INTERVAL_PRESETS = [5, 15, 30, 60];

function ScheduleFormDialog({
  open,
  onOpenChange,
  projectId,
  agents,
  schedule,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  agents: Agent[];
  /** When set, the dialog edits this schedule instead of creating one. */
  schedule?: ScheduleJoined | null;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [intervalValue, setIntervalValue] = React.useState("30");
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskDescription, setTaskDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const activeAgents = agents.filter((a) => a.is_active);

  React.useEffect(() => {
    if (!open) return;
    if (schedule) {
      setName(schedule.name);
      setAgentId(schedule.agent_id);
      setIntervalValue(String(schedule.interval_minutes));
      setTaskTitle(schedule.task_title);
      setTaskDescription(schedule.task_description);
    } else {
      setName("");
      setAgentId("");
      setIntervalValue("30");
      setTaskTitle("");
      setTaskDescription("");
    }
    setError(null);
  }, [open, schedule]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const intervalMinutes = Number.parseInt(intervalValue, 10);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
      setError("Interval must be at least 1 minute.");
      return;
    }
    if (!agentId) {
      setError("Pick an agent to run the task.");
      return;
    }

    setBusy(true);
    try {
      if (schedule) {
        await api(`/api/schedules/${schedule.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            agentId,
            intervalMinutes,
            taskTitle: taskTitle.trim(),
            taskDescription,
          }),
        });
      } else {
        await api(`/api/projects/${projectId}/schedules`, {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            agentId,
            intervalMinutes,
            taskTitle: taskTitle.trim(),
            taskDescription,
          }),
        });
      }
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Failed to save schedule");
      return;
    }
    setBusy(false);
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {schedule ? `Edit ${schedule.name}` : "New schedule"}
          </DialogTitle>
          <DialogDescription>
            The worker queues this task for the agent on every interval.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              placeholder="Morning inbox sweep"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="schedule-agent">Agent</Label>
              <Select
                id="schedule-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                required
              >
                <option value="">Pick an agent…</option>
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.role === "manager" ? " (manager)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="schedule-interval">Every N minutes</Label>
              <Input
                id="schedule-interval"
                type="number"
                min={1}
                value={intervalValue}
                onChange={(e) => setIntervalValue(e.target.value)}
                required
              />
              <div className="flex gap-1.5">
                {INTERVAL_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setIntervalValue(String(preset))}
                    className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {preset}m
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="schedule-task-title">Task title</Label>
            <Input
              id="schedule-task-title"
              placeholder="Check Slack for unanswered questions"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="schedule-task-description">Task description</Label>
            <Textarea
              id="schedule-task-description"
              rows={4}
              placeholder="Everything the agent needs to know each run."
              value={taskDescription}
              onChange={(e) => setTaskDescription(e.target.value)}
            />
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
              {busy
                ? "Saving…"
                : schedule
                  ? "Save changes"
                  : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
