import type {
  AgentRole,
  CloneStatus,
  RunStatus,
  TaskSource,
  TaskStatus,
} from "@agent-fleet/shared";
import { Badge } from "@/components/ui/badge";

const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  queued: { label: "Queued", variant: "secondary" },
  in_progress: { label: "In progress", variant: "default" },
  review: { label: "Review", variant: "warning" },
  done: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const meta = TASK_STATUS_META[status] ?? TASK_STATUS_META.queued;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

const SOURCE_META: Record<
  TaskSource,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  web: { label: "web", variant: "outline" },
  telegram: { label: "telegram", variant: "info" },
  manager: { label: "manager", variant: "default" },
  system: { label: "system", variant: "muted" },
};

export function SourceBadge({ source }: { source: TaskSource }) {
  const meta = SOURCE_META[source] ?? SOURCE_META.web;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

const CLONE_META: Record<
  CloneStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  pending: { label: "pending", variant: "muted" },
  cloning: { label: "cloning", variant: "warning" },
  ready: { label: "ready", variant: "success" },
  error: { label: "error", variant: "destructive" },
};

export function CloneStatusBadge({
  status,
  error,
}: {
  status: CloneStatus;
  error?: string | null;
}) {
  const meta = CLONE_META[status] ?? CLONE_META.pending;
  return (
    <Badge
      variant={meta.variant}
      title={status === "error" && error ? error : undefined}
      className={status === "error" && error ? "cursor-help" : undefined}
    >
      {meta.label}
    </Badge>
  );
}

const RUN_META: Record<
  RunStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  running: { label: "running", variant: "warning" },
  succeeded: { label: "succeeded", variant: "success" },
  failed: { label: "failed", variant: "destructive" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = RUN_META[status] ?? RUN_META.running;
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export function RoleBadge({ role }: { role: AgentRole }) {
  return role === "manager" ? (
    <Badge variant="default">manager</Badge>
  ) : (
    <Badge variant="secondary">specialist</Badge>
  );
}
