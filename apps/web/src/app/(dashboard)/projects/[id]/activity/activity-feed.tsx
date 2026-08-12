"use client";

import * as React from "react";
import Link from "next/link";
import { Activity as ActivityIcon, ArrowUpRight } from "lucide-react";
import type { RunStatus } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { formatDuration, timeAgo } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";

interface ActivityRun {
  id: string;
  status: RunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  task: { id: string; title: string; project_id: string } | null;
  agent: { id: string; name: string } | null;
}

export function ActivityFeed({ projectId }: { projectId: string }) {
  const { data: runs, loading } = usePolling<ActivityRun[]>(
    React.useCallback(async () => {
      const { runs } = await api<{ runs: ActivityRun[] }>(
        `/api/projects/${projectId}/activity`,
      );
      return runs;
    }, [projectId]),
    10000,
    [projectId],
  );

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <p className="mb-5 text-sm text-muted-foreground">
        The latest {runs?.length ?? 0} agent runs across this project.
      </p>

      {loading || !runs ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={ActivityIcon}
          title="No activity yet"
          description="When agents pick up tasks from the queue, every execution shows up here."
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center gap-3 px-4 py-3">
              <RunStatusBadge status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {run.task?.title ?? "Deleted task"}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {run.agent?.name ?? "Unknown agent"}
                  {" · "}
                  {timeAgo(run.started_at)}
                  {" · "}
                  {formatDuration(run.started_at, run.finished_at)}
                  {run.error ? ` · ${run.error}` : ""}
                </div>
              </div>
              {run.task && (
                <Link
                  href={`/projects/${projectId}?task=${run.task.id}`}
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  View logs
                  <ArrowUpRight className="size-3.5" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
