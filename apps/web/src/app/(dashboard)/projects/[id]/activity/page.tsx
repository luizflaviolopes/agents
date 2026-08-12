import type { Metadata } from "next";
import Link from "next/link";
import { Activity as ActivityIcon, ArrowUpRight } from "lucide-react";
import type { RunStatus } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { formatDuration, timeAgo } from "@/lib/format";
import { RunStatusBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Activity" };

interface ActivityRun {
  id: string;
  status: RunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  task: { id: string; title: string; project_id: string } | null;
  agent: { id: string; name: string } | null;
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data } = await supabase
    .from("task_runs")
    .select(
      "id, status, error, started_at, finished_at, task:tasks!inner(id, title, project_id), agent:agents(id, name)",
    )
    .eq("task.project_id", id)
    .order("started_at", { ascending: false })
    .limit(100);

  const runs = (data ?? []) as unknown as ActivityRun[];

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <p className="mb-5 text-sm text-muted-foreground">
        The latest {runs.length} agent runs across this project.
      </p>

      {runs.length === 0 ? (
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
                  href={`/projects/${id}?task=${run.task.id}`}
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
